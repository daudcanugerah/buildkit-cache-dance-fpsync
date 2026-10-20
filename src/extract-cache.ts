import { promises as fs } from 'fs';
import path from 'path';
import {Opts, getCacheMap, getMountArgsString, getTargetPath, getBuilder, isDebug, getUtilityImage, validateSafePath, sanitizeForDockerfile} from './opts.js';
import { run, runPiped, debug, debugSection, debugInspectDirectory, debugSizeComparison } from './run.js';
import { buildExtractDockerfile, buildxContextArgs, toCacheEntries } from './dancefile.js';

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

async function extractCaches(opts: Opts) {
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

    // Security: validate the scratch dir once; per-cache source paths below
    validateSafePath(scratchDir, 'scratch directory');

    // Ensure cache source directories exist
    for (const cacheSource of Object.keys(cacheMap)) {
        validateSafePath(cacheSource, 'cache source');
        await fs.mkdir(cacheSource, { recursive: true });
    }

    const entries = toCacheEntries(cacheMap);
    if (entries.length === 0) {
        console.log(`[cache-dance] extract: no caches configured, nothing to extract`);
        return;
    }

    const extractStart = Date.now();
    debugSection(`EXTRACT CACHES - START`);
    debug(`Total caches to extract: ${entries.length}`);
    debug(`Cache map: ${JSON.stringify(cacheMap, null, 2)}`);

    // Clean Scratch Directory to avoid leftover data from previous iterations.
    await rmrf(scratchDir, 'scratch cleanup');
    await fs.mkdir(scratchDir, { recursive: true });

    // Buildstamp for layer cache busting (main build context)
    const date = new Date().toISOString();
    await fs.writeFile(path.join(scratchDir, 'buildstamp'), date);

    // Security: validate values that will be used in the Dockerfile
    for (const entry of entries) {
        sanitizeForDockerfile(getTargetPath(entry.options));
        sanitizeForDockerfile(getMountArgsString(entry.options));
    }

    // Tar-stream Dancefile: one parallel stage per cache copies its cache
    // mount contents to /out; the final scratch stage merges them all and is
    // exported as one tar stream piped into host-side tar. This avoids both
    // docker cp / docker run and the local exporter: tar as the invoking user
    // strips root ownership (--no-same-owner), so nothing root-owned is ever
    // written and no sudo is needed on the host. Copy uses fpsync (fpart-driven
    // parallel rsync) when available, falling back to plain cp -a otherwise.
    const dancefileContent = buildExtractDockerfile(entries, containerImage, getRsyncMode(opts));
    const dancefilePath = path.join(scratchDir, 'Dancefile.extract');
    await fs.writeFile(dancefilePath, dancefileContent);

    debugSection(`Generated Dancefile.extract (CRITICAL - check mount args)`);
    console.log(dancefileContent);

    // Inspect cache sources before extraction
    const beforeSizes: Record<string, string | null> = {};
    if (debugEnabled) {
        for (const entry of entries) {
            beforeSizes[entry.source] = await debugInspectDirectory(entry.source, `Cache source BEFORE extraction (${entry.source})`);
        }
    }

    // Extraction target. Must not exist beforehand, otherwise tar merges into
    // it and stale files survive.
    const outputDir = path.join(scratchDir, 'out');

    try {
        // Extract via tar stream: BuildKit exports the scratch stage as one tar
        // on stdout (all caches, tagged by stage name), which host-side tar
        // extracts as the runner user.
        // --no-same-owner: never try to restore root ownership (would fail or
        // require sudo); files are owned by the invoking user instead.
        const buildStart = Date.now();
        debug(`Running docker buildx build with --output type=tar, piped to host tar...`);
        debug(`TIP: For more detailed docker output, run with: BUILDKIT_PROGRESS=plain`);

        const buildArgs = [
            'buildx', 'build',
            '--builder', builder,
            '-f', dancefilePath,
            '--target', 'extract',
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
        // step durations per stage; the tar extraction time is the remainder.
        console.log(`[cache-dance] extract build for ${entries.length} cache(s) via single parallel build: ${buildSecs}s (fpsync/cp steps visible in 'RUN' lines above; remainder = tar stream + extraction)`);

        if (debugEnabled) {
            await debugInspectDirectory(outputDir, `Tar extraction output dir`);
        }

        // Each cache's snapshot lands in scratch/out/<stage-name>; swap it into
        // place with a same-filesystem rename - instant even for multi-GB
        // caches, and it inherently drops stale files. No sudo needed: all
        // files are owned by the runner user.
        for (const entry of entries) {
            debug(`Replacing cache source with extracted snapshot: ${entry.source}...`);
            const snapshotDir = path.join(outputDir, entry.name);
            await rmrf(entry.source, 'cache source cleanup');
            await fs.rename(snapshotDir, entry.source);
        }

        // Inspect cache sources after extraction and compare sizes
        if (debugEnabled) {
            for (const entry of entries) {
                const afterSize = await debugInspectDirectory(entry.source, `Cache source AFTER extraction (${entry.source})`);
                debugSizeComparison(beforeSizes[entry.source] ?? null, afterSize, `Extract: ${entry.source}`);
            }
        }

        // Always-print summary: total time
        const totalSecs = elapsedMs(extractStart);
        console.log(`[cache-dance] extract summary: total ${totalSecs}s for ${entries.length} cache(s)`);
    } finally {
        // Cleanup of the extraction output (always runs). No sudo needed since
        // tar extracted as the runner user.
        // Sources were already replaced, and the Dancefile stays for debugging.
        await rmrf(outputDir, 'output cleanup');
    }

    debugSection(`EXTRACT CACHES - COMPLETE`);
}

// Kept as a tiny indirection so tests can stub rsync-mode resolution if needed.
function getRsyncMode(opts: Opts): boolean {
    return opts["rsync-mode"] === true;
}

export { extractCaches };
