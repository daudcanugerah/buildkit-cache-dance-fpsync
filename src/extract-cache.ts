import { promises as fs } from 'fs';
import path from 'path';
import {CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getBuilder, generateUniqueSuffix, isDebug, isRsyncMode, getUtilityImage, validateSafePath, sanitizeForDockerfile} from './opts.js';
import { run, debug, debugSection, debugInspectDirectory, debugSizeComparison } from './run.js';

function elapsedMs(start: number): number {
  return Math.round((Date.now() - start) / 10) / 100;
}

async function extractCache(cacheSource: string, cacheOptions: CacheOptions, scratchDir: string, containerImage: string, builder: string, debugEnabled: boolean, rsyncEnabled: boolean) {
    // Security: Validate cacheSource is a safe relative path
    validateSafePath(cacheSource, 'cache source');
    validateSafePath(scratchDir, 'scratch directory');

    // Generate unique suffix for this cache to avoid conflicts with multiple caches
    const uniqueSuffix = generateUniqueSuffix(cacheSource);

    debugSection(`EXTRACT CACHE: ${cacheSource}`);
    debug(`Cache source (destination): ${cacheSource}`);
    debug(`Cache options: ${JSON.stringify(cacheOptions)}`);
    debug(`Scratch dir: ${scratchDir}`);
    debug(`Container image: ${containerImage}`);
    debug(`Builder: ${builder}`);
    debug(`Unique suffix: ${uniqueSuffix}`);
    debug(`Rsync mode: ${rsyncEnabled}`);

    // Clean Scratch Directory to avoid leftover data from previous iterations.
    // sudo: the local exporter of a previous run may have left root-owned files.
    await run('sudo', ['rm', '-rf', scratchDir]);
    await fs.mkdir(scratchDir, { recursive: true });

    // Prepare Timestamp for Layer Cache Busting
    const date = new Date().toISOString();
    await fs.writeFile(path.join(scratchDir, 'buildstamp'), date);

    // Prepare Dancefile to Access Caches
    const targetPath = getTargetPath(cacheOptions);
    const mountArgs = getMountArgsString(cacheOptions);

    // Security: Validate values that will be used in Dockerfile
    sanitizeForDockerfile(targetPath);
    sanitizeForDockerfile(mountArgs);

    debug(`Target path: ${targetPath}`);
    debug(`Mount args (CRITICAL): ${mountArgs}`);

    // Multi-stage Dancefile: copy cache contents to /out in a stage, then export
    // only that directory from a scratch stage via --output type=local.
    // This avoids --load + docker cp / docker run entirely: BuildKit writes the
    // files directly to the local filesystem.
    // Copy uses fpsync (fpart-driven parallel rsync) when available, falling
    // back to plain cp -a otherwise. cp -a preserves hardlinks and symlinks.
    const dancefileContent = `
FROM ${containerImage} AS dance-cache
COPY buildstamp buildstamp
RUN --mount=${mountArgs} \\
    mkdir -p /out \\
    && if command -v fpsync >/dev/null 2>&1; then \\
        fpsync -n $(nproc) -o "-H" -t /tmp/fpsync ${targetPath}/ /out/; \\
    else \\
        cp -a ${targetPath}/. /out/; \\
    fi || true

FROM scratch
COPY --from=dance-cache /out /
`;

    await fs.writeFile(path.join(scratchDir, 'Dancefile.extract'), dancefileContent);

    debugSection(`Generated Dancefile.extract (CRITICAL - check mount args)`);
    console.log(dancefileContent);

    // Inspect cache source before extraction
    let beforeSize: string | null = null;
    if (debugEnabled) {
        beforeSize = await debugInspectDirectory(cacheSource, `Cache source BEFORE extraction (${cacheSource})`);
    }

    // Output directory for the local exporter. Must not exist beforehand,
    // otherwise the local exporter merges into it and stale files survive.
    const outputDir = path.join(scratchDir, 'out');
    const absoluteCacheSource = path.resolve(cacheSource);
    const extractStart = Date.now();

    // Ensure cache source directory exists
    await fs.mkdir(cacheSource, { recursive: true });

    try {
        // Extract Data directly to local filesystem via BuildKit local exporter
        const buildStart = Date.now();
        debug(`Running docker buildx build with --output type=local for extraction...`);
        debug(`TIP: For more detailed docker output, run with: BUILDKIT_PROGRESS=plain`);

        // Use --progress=plain in debug mode for detailed output
        const buildArgs = [
            'buildx', 'build',
            '--builder', builder,
            '-f', path.join(scratchDir, 'Dancefile.extract'),
            '--output', `type=local,dest=${outputDir}`,
        ];
        if (debugEnabled) {
            buildArgs.push('--progress=plain');
        }
        buildArgs.push(scratchDir);

        await run('docker', buildArgs);
        const buildSecs = elapsedMs(buildStart);

        // The build log (--progress=plain in debug mode) shows the fpsync/cp
        // step duration; the exporter write time is the remainder.
        console.log(`[cache-dance] extract build for '${cacheSource}': ${buildSecs}s (fpsync/cp step visible in 'RUN' line above; remainder = local exporter write)`);

        if (debugEnabled) {
            await debugInspectDirectory(outputDir, `Local export output dir`);
        }

        // The local exporter writes files as root (docker driver), so cleanup
        // and moves into cacheSource must use sudo on the host.
        if (rsyncEnabled) {
            // rsync mode: differential sync from exported output to host cache-dir
            // -a: archive (permissions, timestamps, symlinks, owner)
            // -H: preserve hardlinks (pnpm stores are hardlink-heavy)
            // --delete: remove files in destination that don't exist in source
            debug(`Using rsync mode: syncing exported output to host cache-dir...`);
            const rsyncStart = Date.now();
            await run('sudo', [
                'rsync', '-a', '-H', '--delete',
                `${outputDir}/`, `${absoluteCacheSource}/`,
            ]);
            console.log(`[cache-dance] extract host rsync -> '${cacheSource}': ${elapsedMs(rsyncStart)}s`);
        } else {
            // Default mode: replace cache source with exported output
            debug(`Using cp mode: moving exported output to cache source...`);
            await run('sudo', ['rm', '-rf', cacheSource]);
            await run('sudo', ['mv', outputDir, cacheSource]);
        }

        // Inspect cache source after extraction and compare sizes
        let afterSize: string | null = null;
        if (debugEnabled) {
            afterSize = await debugInspectDirectory(cacheSource, `Cache source AFTER extraction (${cacheSource})`);
            debugSizeComparison(beforeSize, afterSize, `Extract: ${cacheSource}`);
        }

        // Always-print summary: total time and data size for this cache
        const totalSecs = elapsedMs(extractStart);
        if (debugEnabled && afterSize) {
            console.log(`[cache-dance] extract '${cacheSource}' summary: total ${totalSecs}s, size ${afterSize}`);
        } else {
            console.log(`[cache-dance] extract '${cacheSource}' summary: total ${totalSecs}s`);
        }
    } finally {
        // Cleanup: remove root-owned export output (always runs).
        // cacheSource was already synced/moved, and the Dancefile stays for debugging.
        await run('sudo', ['rm', '-rf', outputDir]);
    }

    debug(`Extract cache completed for: ${cacheSource}`);
}

export async function extractCaches(opts: Opts) {
    const debugEnabled = isDebug(opts);
    const rsyncEnabled = isRsyncMode(opts);

    debugSection(`EXTRACT CACHES - POST JOB CLEANUP`);
    debug(`skip-extraction: ${opts["skip-extraction"]}`);
    debug(`Rsync mode: ${rsyncEnabled}`);

    if (opts["skip-extraction"]) {
        console.log("skip-extraction is set. Skipping extraction step...");
        return;
    }

    const cacheMap = await getCacheMap(opts);
    const scratchDir = opts['scratch-dir'];
    const containerImage = getUtilityImage(opts);
    const builder = getBuilder(opts);

    const extractStart = Date.now();
    debugSection(`EXTRACT CACHES - START`);
    debug(`Total caches to extract: ${Object.keys(cacheMap).length}`);
    debug(`Cache map: ${JSON.stringify(cacheMap, null, 2)}`);
    debug(`Rsync mode: ${rsyncEnabled}`);

    // Extract Caches for each source-target pair
    for (const [cacheSource, cacheOptions] of Object.entries(cacheMap)) {
        await extractCache(cacheSource, cacheOptions, scratchDir, containerImage, builder, debugEnabled, rsyncEnabled);
    }

    if (debugEnabled) {
        debugSection(`EXTRACT CACHES - TIMING`);
        debug(`Extract total: ${elapsedMs(extractStart)}s (use this to verify cache/rsync improvement)`);
    }
    console.log(`[cache-dance] extract phase complete: total ${elapsedMs(extractStart)}s for ${Object.keys(cacheMap).length} cache(s)`);
    debugSection(`EXTRACT CACHES - COMPLETE`);
}
