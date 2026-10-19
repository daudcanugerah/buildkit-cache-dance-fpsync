import { promises as fs } from 'fs';
import path from 'path';
import {CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getBuilder, generateUniqueSuffix, isDebug, getUtilityImage, validateSafePath, sanitizeForDockerfile} from './opts.js';
import { run, runPiped, debug, debugSection, debugInspectDirectory, debugSizeComparison } from './run.js';

function elapsedMs(start: number): number {
  return Math.round((Date.now() - start) / 10) / 100;
}

// Remove a directory tree. Falls back to sudo only when the plain removal
// fails (e.g. legacy dirs from older versions that contain root-owned files
// left by the former local-exporter flow).
async function rmrf(dir: string, label: string) {
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch (err: any) {
        debug(`${label}: plain rm failed (${err?.code ?? err}), retrying with sudo`);
        await run('sudo', ['rm', '-rf', dir]);
    }
}

async function extractCache(cacheSource: string, cacheOptions: CacheOptions, scratchDir: string, containerImage: string, builder: string, debugEnabled: boolean) {
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

    // Clean Scratch Directory to avoid leftover data from previous iterations.
    await rmrf(scratchDir, 'scratch cleanup');
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

    // Tar-stream Dancefile: copy cache contents to /out in a stage, then export
    // that directory as a tar stream piped into host-side tar. This avoids both
    // docker cp / docker run and the local exporter: tar as the invoking user
    // strips root ownership (--no-same-owner), so nothing root-owned is ever
    // written and no sudo is needed on the host.
    // Copy uses fpsync (fpart-driven parallel rsync) when available, falling
    // back to plain cp -a otherwise. cp -a preserves hardlinks and symlinks.
    // -s 500: partition by ~500 MiB of file size so trees with few large files
    //         (apt .deb archives) still split across parallel jobs
    // -f 2000: fpsync's default max files per partition (explicit here so
    //          many-small-file trees like Go/pnpm caches split predictably)
    const dancefileContent = `
FROM ${containerImage} AS dance-cache
COPY buildstamp buildstamp
RUN --mount=${mountArgs} \\
    mkdir -p /out \\
    && if command -v fpsync >/dev/null 2>&1; then \\
        fpsync -n $((2 * $(nproc))) -o "-H" -s 500 -f 2000 -t /tmp/fpsync ${targetPath}/ /out/; \\
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

    // Extraction target. Must not exist beforehand, otherwise tar merges into
    // it and stale files survive.
    const outputDir = path.join(scratchDir, 'out');
    const extractStart = Date.now();

    // Ensure cache source directory exists
    await fs.mkdir(cacheSource, { recursive: true });

    try {
        // Extract via tar stream: BuildKit exports the scratch stage as a tar
        // on stdout, which host-side tar extracts as the runner user.
        // --no-same-owner: never try to restore root ownership (would fail or
        // require sudo); files are owned by the invoking user instead.
        const buildStart = Date.now();
        debug(`Running docker buildx build with --output type=tar, piped to host tar...`);
        debug(`TIP: For more detailed docker output, run with: BUILDKIT_PROGRESS=plain`);

        const buildArgs = [
            'buildx', 'build',
            '--builder', builder,
            '-f', path.join(scratchDir, 'Dancefile.extract'),
            '--output', 'type=tar',
        ];
        if (debugEnabled) {
            buildArgs.push('--progress=plain');
        }
        buildArgs.push(scratchDir);

        await rmrf(outputDir, 'output cleanup');
        await fs.mkdir(outputDir, { recursive: true });
        await runPiped(['docker', buildArgs], ['tar', ['-x', '-C', outputDir, '--no-same-owner']]);
        const buildSecs = elapsedMs(buildStart);

        // The build log (--progress=plain in debug mode) shows the fpsync/cp
        // step duration; the tar extraction time is the remainder.
        console.log(`[cache-dance] extract build for '${cacheSource}': ${buildSecs}s (fpsync/cp step visible in 'RUN' line above; remainder = tar stream + extraction)`);

        if (debugEnabled) {
            await debugInspectDirectory(outputDir, `Tar extraction output dir`);
        }

        // The extraction is a complete snapshot, so replacing the cache source
        // is a same-filesystem rename - instant even for multi-GB caches, and
        // it inherently drops stale files. No sudo needed: all files are owned
        // by the runner user.
        debug(`Replacing cache source with extracted snapshot...`);
        await rmrf(cacheSource, 'cache source cleanup');
        await fs.rename(outputDir, cacheSource);

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
        // Cleanup of the extraction output (always runs). No sudo needed since
        // tar extracted as the runner user.
        // cacheSource was already replaced, and the Dancefile stays for debugging.
        await rmrf(outputDir, 'output cleanup');
    }

    debug(`Extract cache completed for: ${cacheSource}`);
}

export async function extractCaches(opts: Opts) {
    const debugEnabled = isDebug(opts);

    debugSection(`EXTRACT CACHES - POST JOB CLEANUP`);
    debug(`skip-extraction: ${opts["skip-extraction"]}`);

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

    // Extract Caches for each source-target pair
    for (const [cacheSource, cacheOptions] of Object.entries(cacheMap)) {
        await extractCache(cacheSource, cacheOptions, scratchDir, containerImage, builder, debugEnabled);
    }

    if (debugEnabled) {
        debugSection(`EXTRACT CACHES - TIMING`);
        debug(`Extract total: ${elapsedMs(extractStart)}s (use this to verify cache improvement)`);
    }
    console.log(`[cache-dance] extract phase complete: total ${elapsedMs(extractStart)}s for ${Object.keys(cacheMap).length} cache(s)`);
    debugSection(`EXTRACT CACHES - COMPLETE`);
}
