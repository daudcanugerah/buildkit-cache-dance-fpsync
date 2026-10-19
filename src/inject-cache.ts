import { promises as fs } from "fs";
import path from 'path';
import { CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getUID, getGID, getBuilder, generateUniqueSuffix, isDebug, isRsyncMode, getUtilityImage, validateSafePath, sanitizeForDockerfile } from './opts.js';
import { run, debug, debugSection, debugInspectDirectory } from './run.js';

function elapsedMs(start: number): number {
  return Math.round((Date.now() - start) / 10) / 100;
}
import { notice } from '@actions/core/lib/core.js';

async function injectCache(cacheSource: string, cacheOptions: CacheOptions, scratchDir: string, containerImage: string, builder: string, debugEnabled: boolean, rsyncEnabled: boolean) {
    // Security: Validate cacheSource is a safe relative path
    validateSafePath(cacheSource, 'cache source');
    validateSafePath(scratchDir, 'scratch directory');

    // Generate unique image name for this cache to avoid conflicts with multiple caches
    const uniqueSuffix = generateUniqueSuffix(cacheSource);
    const imageName = `dance:inject-${uniqueSuffix}`;

    debugSection(`INJECT CACHE: ${cacheSource}`);
    debug(`Cache source: ${cacheSource}`);
    debug(`Cache options: ${JSON.stringify(cacheOptions)}`);
    debug(`Scratch dir: ${scratchDir}`);
    debug(`Container image: ${containerImage}`);
    debug(`Builder: ${builder}`);
    debug(`Unique suffix: ${uniqueSuffix}`);
    debug(`Image name: ${imageName}`);
    debug(`Rsync mode: ${rsyncEnabled}`);

    // Clean Scratch Directory
    await fs.rm(scratchDir, { recursive: true, force: true });
    await fs.mkdir(scratchDir, { recursive: true });

    // Prepare Cache Source Directory
    await fs.mkdir(cacheSource, { recursive: true });

    // Skip the dance build entirely when there is nothing to inject (first
    // run, or after cache eviction): copying an empty dir still pays for a
    // full buildx build plus image tag/cleanup.
    const cacheEntries = await fs.readdir(cacheSource);
    if (cacheEntries.length === 0) {
        console.log(`[cache-dance] inject '${cacheSource}': cache source is empty, skipping injection build`);
        return;
    }

    // Inspect cache source before injection
    if (debugEnabled) {
        await debugInspectDirectory(cacheSource, `Cache source BEFORE injection (${cacheSource})`);
    }

    // Prepare Timestamp for Layer Cache Busting
    const date = new Date().toISOString();
    await fs.writeFile(path.join(cacheSource, 'buildstamp'), date);

    const targetPath = getTargetPath(cacheOptions);
    const mountArgs = getMountArgsString(cacheOptions);

    // Security: Validate values that will be used in Dockerfile
    sanitizeForDockerfile(targetPath);
    sanitizeForDockerfile(mountArgs);

    debug(`Target path: ${targetPath}`);
    debug(`Mount args: ${mountArgs}`);

    // If UID OR GID are set, then add chown to restore files ownership.
    let ownershipCommand = "";
    const uid = getUID(cacheOptions);
    const gid = getGID(cacheOptions);
    if (uid !== "" || gid !== "") {
        ownershipCommand = `&& chown -R ${uid}:${gid} ${targetPath}`
        debug(`Ownership command: ${ownershipCommand}`);
    }

    // Prepare Dancefile to Access Caches
    let dancefileContent: string;

    if (rsyncEnabled) {
        // rsync mode: Use parallel fpsync for differential sync (much faster on
        // subsequent and cold runs) when fpsync is available (rsync utility image),
        // falling back to single rsync otherwise.
        // --ignore-existing: Skip files that already exist in destination (incremental)
        // -H: preserve hardlinks across fpart chunks (pnpm stores are hardlink-heavy)
        // -s 500: partition by ~500 MiB of file size so trees with few large
        //         files (apt .deb archives) still split across parallel jobs
        // -f 2000: fpsync's default max files per partition (explicit here so
        //          many-small-file trees like Go/pnpm caches split predictably)
        dancefileContent = `
FROM ${containerImage}
COPY buildstamp buildstamp
RUN --mount=${mountArgs} \\
    --mount=type=bind,source=.,target=/var/dance-cache \\
    if command -v fpsync >/dev/null 2>&1; then \\
        fpsync -n $((2 * $(nproc))) -o "--ignore-existing -H" -s 500 -f 2000 -t /tmp/fpsync /var/dance-cache/ ${targetPath}/; \\
    else \\
        rsync -a --ignore-existing /var/dance-cache/ ${targetPath}/; \\
    fi ${ownershipCommand} || true
`;
    } else {
        // Default mode: Use cp for full copy
        dancefileContent = `
FROM ${containerImage}
COPY buildstamp buildstamp
RUN --mount=${mountArgs} \\
    --mount=type=bind,source=.,target=/var/dance-cache \\
    cp -p -R /var/dance-cache/. ${targetPath} ${ownershipCommand} || true
`;
    }

    await fs.writeFile(path.join(scratchDir, 'Dancefile.inject'), dancefileContent);

    debugSection(`Generated Dancefile.inject`);
    console.log(dancefileContent);

    try {
        // Inject Data into Docker Cache
        const buildStart = Date.now();
        debug(`Running docker buildx build for injection...`);
        debug(`TIP: For more detailed docker output, run with: BUILDKIT_PROGRESS=plain`);

        // Use --progress=plain in debug mode for detailed output
        const buildArgs = ['buildx', 'build', '--builder', builder, '-f', path.join(scratchDir, 'Dancefile.inject'), '--tag', imageName];
        if (debugEnabled) {
            buildArgs.push('--progress=plain');
        }
        buildArgs.push(cacheSource);

        await run('docker', buildArgs);
        const buildSecs = elapsedMs(buildStart);

        // Report the timing breakdown. In debug mode the build log (printed
        // above with --progress=plain) already shows the fpsync/rsync step
        // duration; here we log the total for quick comparison.
        console.log(`[cache-dance] inject '${cacheSource}' -> ${targetPath}: total ${buildSecs}s (fpsync/rsync copy duration in 'RUN' step above)`);
        debug(`Inject docker build (incl. copy): ${buildSecs}s`);    } finally {
        // Cleanup: Remove the temporary image (always runs)
        try {
            await run('docker', ['rmi', '-f', imageName]);
        } catch (error) {
            // Ignore cleanup errors
        }
    }

    // Clean Directories
    try {
        await fs.rm(cacheSource, { recursive: true, force: true });
    } catch (err) {
        // Ignore Cleaning Errors
        notice(`Error while cleaning cache source directory: ${err}. Ignoring...`);
    }
}


export async function injectCaches(opts: Opts) {
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

    // Inject Caches for each source-target pair
    for (const [cacheSource, cacheOptions] of Object.entries(cacheMap)) {
        await injectCache(cacheSource, cacheOptions, scratchDir, containerImage, builder, debugEnabled, rsyncEnabled);
    }

    if (debugEnabled) {
        debugSection(`INJECT CACHES - TIMING`);
        debug(`Inject total: ${elapsedMs(injectStart)}s (use this to verify cache/rsync improvement)`);
    }
    console.log(`[cache-dance] inject phase complete: total ${elapsedMs(injectStart)}s for ${Object.keys(cacheMap).length} cache(s)`);
    debugSection(`INJECT CACHES - COMPLETE`);
}
