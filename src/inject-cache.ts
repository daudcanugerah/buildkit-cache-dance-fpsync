import { promises as fs } from "fs";
import path from 'path';
import { CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getBuilder, generateUniqueSuffix, isDebug, isRsyncMode, getUtilityImage, validateSafePath, sanitizeForDockerfile } from './opts.js';
import { run, debug, debugSection, debugInspectDirectory } from './run.js';
import { CacheEntry, buildInjectDockerfile, buildxContextArgs, toCacheEntries } from './dancefile.js';
import { notice } from '@actions/core/lib/core.js';

function elapsedMs(start: number): number {
  return Math.round((Date.now() - start) / 10) / 100;
}

async function injectCaches(opts: Opts) {
    const debugEnabled = isDebug(opts);
    const rsyncEnabled = isRsyncMode(opts);
    const cacheMap = await getCacheMap(opts);
    const scratchDir = opts['scratch-dir'];
    const containerImage = getUtilityImage(opts);
    const builder = getBuilder(opts);

    const injectStart = Date.now();
    debugSection(`INJECT CACHES - START`);
    debug(`Total caches to inject: ${Object.keys(cacheMap).length}`);
    debug(`Cache map: ${JSON.stringify(cacheMap, null, 2)}`);
    debug(`Rsync mode: ${rsyncEnabled}`);

    // Security: validate the scratch dir once; per-cache source paths below
    validateSafePath(scratchDir, 'scratch directory');

    // Clean Scratch Directory
    await fs.rm(scratchDir, { recursive: true, force: true });
    await fs.mkdir(scratchDir, { recursive: true });

    // Prepare cache sources: create each, skip the empty ones (first run or
    // after cache eviction - copying an empty dir would still pay for a stage).
    const includedCacheMap: Record<string, CacheOptions> = {};
    for (const [cacheSource, cacheOptions] of Object.entries(cacheMap)) {
        validateSafePath(cacheSource, 'cache source');
        await fs.mkdir(cacheSource, { recursive: true });

        const cacheEntries = await fs.readdir(cacheSource);
        if (cacheEntries.length === 0) {
            console.log(`[cache-dance] inject '${cacheSource}': cache source is empty, skipping`);
            continue;
        }

        if (debugEnabled) {
            await debugInspectDirectory(cacheSource, `Cache source BEFORE injection (${cacheSource})`);
        }

        includedCacheMap[cacheSource] = cacheOptions;
    }

    const entries = toCacheEntries(includedCacheMap);
    if (entries.length === 0) {
        console.log(`[cache-dance] inject: all cache sources are empty, nothing to inject`);
        return;
    }

    // Buildstamp lives in the main build context (scratch dir) and busts every
    // per-cache stage at once.
    const date = new Date().toISOString();
    await fs.writeFile(path.join(scratchDir, 'buildstamp'), date);

    // Security: validate values that will be used in the Dockerfile
    for (const entry of entries) {
        sanitizeForDockerfile(getTargetPath(entry.options));
        sanitizeForDockerfile(getMountArgsString(entry.options));
    }

    const dancefilePath = path.join(scratchDir, 'Dancefile.inject');
    const dancefileContent = buildInjectDockerfile(entries, containerImage, rsyncEnabled);
    await fs.writeFile(dancefilePath, dancefileContent);

    debugSection(`Generated Dancefile.inject`);
    console.log(dancefileContent);

    // Unique image name; derived from all sources to avoid conflicts across runs
    const imageName = `dance:inject-${generateUniqueSuffix(entries.map(e => e.source).join('-'))}`;

    debug(`Container image: ${containerImage}`);
    debug(`Builder: ${builder}`);
    debug(`Image name: ${imageName}`);
    debug(`Rsync mode: ${rsyncEnabled}`);
    for (const entry of entries) {
        debug(`Cache: ${entry.source} -> ${getTargetPath(entry.options)} (stage ${entry.name})`);
    }

    try {
        // Inject data into BuildKit's cache mounts: ONE build, all caches as
        // parallel stages (BuildKit schedules independent stages concurrently).
        const buildStart = Date.now();
        debug(`Running docker buildx build for injection...`);
        debug(`TIP: For more detailed docker output, run with: BUILDKIT_PROGRESS=plain`);

        // Use --progress=plain in debug mode for detailed output
        const buildArgs = [
            'buildx', 'build',
            '--builder', builder,
            '-f', dancefilePath,
            '--target', 'inject',
            '--tag', imageName,
            ...buildxContextArgs(entries),
        ];
        if (debugEnabled) {
            buildArgs.push('--progress=plain');
        }
        buildArgs.push(scratchDir);

        await run('docker', buildArgs);
        const buildSecs = elapsedMs(buildStart);

        // In debug mode the build log (printed above with --progress=plain)
        // shows each stage's fpsync/rsync step duration; here the total.
        console.log(`[cache-dance] inject ${entries.length} cache(s) via single parallel build: total ${buildSecs}s (per-cache fpsync/rsync durations in 'RUN' steps above)`);
        debug(`Inject docker build (incl. copies): ${buildSecs}s`);
    } finally {
        // Cleanup: Remove the temporary image (always runs)
        try {
            await run('docker', ['rmi', '-f', imageName]);
        } catch (error) {
            // Ignore cleanup errors
        }
    }

    // Clean cache source directories (their content now lives in BuildKit's
    // cache mounts; actions/cache re-materializes them from its archive).
    for (const entry of entries) {
        try {
            await fs.rm(entry.source, { recursive: true, force: true });
        } catch (err) {
            notice(`Error while cleaning cache source directory: ${err}. Ignoring...`);
        }
    }

    if (debugEnabled) {
        debugSection(`INJECT CACHES - TIMING`);
        debug(`Inject total: ${elapsedMs(injectStart)}s (use this to verify cache/rsync improvement)`);
    }
    console.log(`[cache-dance] inject phase complete: total ${elapsedMs(injectStart)}s for ${entries.length} cache(s)`);
    debugSection(`INJECT CACHES - COMPLETE`);
}

export { injectCaches };
