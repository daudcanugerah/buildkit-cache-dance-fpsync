import {
    CacheOptions,
    TargetPath,
    generateUniqueSuffix,
    getGID,
    getMountArgsString,
    getTargetPath,
    getUID,
} from './opts.js';

/**
 * A single cache entry to inject/extract, pre-processed from the cache map.
 */
export type CacheEntry = {
    /** Host path of the cache source (relative, validated) */
    source: string,
    /** Cache mount options from the cache map */
    options: CacheOptions,
    /** Unique stage name, safe for use in Dockerfiles and image tags */
    name: string,
}

/**
 * Turn a cache map into ordered entries with unique, Dockerfile-safe stage names.
 * The index prefix guarantees uniqueness even when two sources normalize to the
 * same suffix (e.g. "a/b" and "a-b").
 */
export function toCacheEntries(cacheMap: Record<string, CacheOptions>): CacheEntry[] {
    return Object.entries(cacheMap).map(([source, options], index) => ({
        source,
        options,
        name: `c${index}-${generateUniqueSuffix(source)}`,
    }));
}

/** The named build context id used to expose a cache source inside the build. */
export function sourceContextName(entry: CacheEntry): string {
    return `src-${entry.name}`;
}

function ownershipCommand(targetPath: TargetPath, options: CacheOptions): string {
    const uid = getUID(options);
    const gid = getGID(options);
    if (uid === "" && gid === "") {
        return "";
    }
    return ` && chown -R ${uid}:${gid} ${targetPath}`;
}

function stageName(entry: CacheEntry): string {
    return entry.name;
}

/**
 * Build the single Dancefile used by the inject phase:
 * one parallel stage per cache (each writes into its own cache mount), and a
 * final "inject" stage that forces all stages to build. BuildKit schedules the
 * per-cache stages in parallel.
 *
 * Requires Dockerfile syntax >= 1.4 (named build contexts).
 */
export function buildInjectDockerfile(entries: CacheEntry[], containerImage: string, rsyncEnabled: boolean): string {
    const parts: string[] = [`# syntax=docker/dockerfile:1.4\n`];

    for (const entry of entries) {
        const targetPath = getTargetPath(entry.options);
        const mountArgs = getMountArgsString(entry.options);
        const owner = ownershipCommand(targetPath, entry.options);
        const copy = rsyncEnabled ? fpsyncInjectStep(targetPath) : cpInjectStep(targetPath);
        parts.push(`FROM ${containerImage} AS ${stageName(entry)}
COPY buildstamp /buildstamp
RUN --mount=type=bind,from=${sourceContextName(entry)},source=.,target=/var/dance-cache \\
    --mount=${mountArgs} \\
    ${copy}${owner} || true
`);
    }

    // Final stage: reference every per-cache stage so BuildKit builds them all.
    parts.push(`FROM ${containerImage} AS inject
`);
    for (const entry of entries) {
        parts.push(`COPY --from=${stageName(entry)} /buildstamp /inject-${stageName(entry)}
`);
    }

    return parts.join('\n');
}

function fpsyncInjectStep(targetPath: TargetPath): string {
    return `mkdir -p ${targetPath} \\
    && if command -v fpsync >/dev/null 2>&1; then \\
        fpsync -n $((2 * $(nproc))) -o "--ignore-existing -H" -s 500 -f 2000 -t /tmp/fpsync /var/dance-cache/ ${targetPath}/; \\
    else \\
        rsync -a --ignore-existing /var/dance-cache/ ${targetPath}/; \\
    fi`;
}

function cpInjectStep(targetPath: TargetPath): string {
    return `mkdir -p ${targetPath} \\
    && cp -p -R /var/dance-cache/. ${targetPath}`;
}

/**
 * Build the single Dancefile used by the extract phase: one parallel stage per
 * cache copying its cache mount into /out, merged by the final "extract" stage
 * (FROM scratch) which is exported as a tar stream by buildx.
 */
export function buildExtractDockerfile(entries: CacheEntry[], containerImage: string, rsyncEnabled: boolean): string {
    const parts: string[] = [`# syntax=docker/dockerfile:1.4\n`];

    for (const entry of entries) {
        const targetPath = getTargetPath(entry.options);
        const mountArgs = getMountArgsString(entry.options);
        const copy = rsyncEnabled ? fpsyncExtractStep(targetPath) : cpExtractStep(targetPath);
        parts.push(`FROM ${containerImage} AS ${stageName(entry)}
COPY buildstamp /buildstamp
RUN --mount=${mountArgs} \\
    mkdir -p /out \\
    && ${copy} || true
`);
    }

    // Final stage: merges every per-cache /out into one tar-exportable tree.
    parts.push(`FROM scratch AS extract
`);
    for (const entry of entries) {
        parts.push(`COPY --from=${stageName(entry)} /out /${stageName(entry)}/
`);
    }

    return parts.join('\n');
}

function fpsyncExtractStep(targetPath: TargetPath): string {
    return `if command -v fpsync >/dev/null 2>&1; then \\
        fpsync -n $((2 * $(nproc))) -o "-H" -s 500 -f 2000 -t /tmp/fpsync ${targetPath}/ /out/; \\
    else \\
        cp -a ${targetPath}/. /out/; \\
    fi`;
}

function cpExtractStep(targetPath: TargetPath): string {
    return `cp -a ${targetPath}/. /out/`;
}

/**
 * Buildx args introducing one named build context per cache source, so a single
 * build receives every cache directory without sending a larger context.
 * Paths must be absolute.
 */
export function buildxContextArgs(entries: CacheEntry[]): string[] {
    const args: string[] = [];
    for (const entry of entries) {
        args.push('--build-context', `${sourceContextName(entry)}=${entry.source}`);
    }
    return args;
}
