import mri from 'mri';
import { promises as fs } from 'fs';
import path from 'path';
import { getInput, warning, info } from '@actions/core/lib/core.js';
import { DockerfileParser, ModifiableInstruction } from 'dockerfile-ast';

export type Opts = {
  "extract": boolean
  "cache-map": string
  "dockerfile": string
  "cache-dir": string | null
  "scratch-dir": string
  "skip-extraction": boolean
  "utility-image": string
  "builder"?: string
  "is-debug": boolean
  "rsync-mode": boolean
  help: boolean
  /** @deprecated Use `cache-map` instead */
  "cache-source"?: string
  /** @deprecated Use `cache-map` instead */
  "cache-target"?: string
}

export function parseOpts(args: string[]): mri.Argv<Opts> {
  const opts = mri<Opts>(args, {
    default: {
      "cache-map": getInput("cache-map") || "{}",
      "dockerfile": getInput("dockerfile") || "Dockerfile",
      "cache-dir": getInput("cache-dir") || null,
      "scratch-dir": getInput("scratch-dir") || "scratch",
      "skip-extraction": (getInput("skip-extraction") || "false") === "true",
      "extract": process.env[`STATE_POST`] !== undefined,
      "utility-image": getInput("utility-image") || "ghcr.io/containerd/busybox:latest",
      "builder": getInput("builder") || "default",
      "is-debug": (getInput("is-debug") || "false") === "true",
      "rsync-mode": (getInput("rsync-mode") || "true") === "true",
      "help": false,
    },
    string: ["cache-map", "dockerfile", "cache-dir", "scratch-dir", "cache-source", "cache-target", "utility-image", "builder"],
    boolean: ["skip-extraction", "help", "extract", "is-debug", "rsync-mode"],
    alias: {
      "help": ["h"],
    },
  })

  if (opts["cache-source"] && opts["cache-target"]) {
    warning("The `cache-source` and `cache-target` options are deprecated. Use `cache-map` instead.")

    opts["cache-map"] = JSON.stringify({
      [opts["cache-source"]]: opts["cache-target"],
    });
  }

  return opts;
}

export function help() {
  console.log(`build-cache-dance [options]
Save 'RUN --mount=type=cache' caches on GitHub Actions or other CI platforms

Options:
  --extract      Extract the cache from the docker container (extract step). Otherwise, inject the cache (main step)
  --cache-map    The map of actions source paths to container destination paths or mount arguments
  --dockerfile   The Dockerfile to use for auto-discovery of the cache-map. Default: 'Dockerfile'
  --cache-dir    The root directory where cache content is injected from/extracted to when using auto-discovery of the cache-map.
  --scratch-dir  Where the action is stores some temporary files for its processing. Default: 'scratch'
  --skip-extraction  Skip the extraction of the cache from the docker container
  --utility-image  The container image to use for injecting and extracting the cache. Default: 'ghcr.io/containerd/busybox:latest'
  --builder      The name of the buildx builder to use for the cache injection
  --is-debug     Enable verbose debug logs for troubleshooting. Default: 'false'
  --rsync-mode   Use rsync for differential sync instead of cp -R. Much faster for large caches. Default: 'true'
  --help         Show this help
`);
}

export type SourcePath = string
export type TargetPath = string
export type ToStringable = {
  toString(): string;
}
export type CacheOptions = TargetPath | { target: TargetPath } & Record<string, ToStringable>
export type CacheMap = Record<SourcePath, CacheOptions>

async function getCacheMapFromDockerfile(dockerfilePath: string, bindRoot: string | null): Promise<CacheMap> {
  const dockerfileContent = await fs.readFile(dockerfilePath, "utf-8");
  const dockerfile = DockerfileParser.parse(dockerfileContent);

  const cacheMap: CacheMap = {};

  const runInstructions = dockerfile.getInstructions().filter(i => i.getKeyword() == 'RUN') as Array<ModifiableInstruction>;
  for (const run of runInstructions) {
    for (const flag of run.getFlags()) {
      if (flag.getName() == 'mount' && flag.getOption('type')?.getValue() == 'cache') {
        // Extract the `id` flag which defaults to `target` when `id` is not set
        // https://docs.docker.com/reference/dockerfile/#run---mounttypecache
        const id = flag.getOption('id')?.getValue() || flag.getOption('target')?.getValue();
        if (id == null) {
          throw new Error('cache mount must define id or target: ' + flag.toString() + ' in ' + run.toString());
        }

        // The directory on the host to inject/extract the cache mount data from
        // Use path.basename to prevent path traversal attacks (e.g., id containing '..')
        const normalizedId = path.basename(id);
        const bindDir = bindRoot !== null ? path.join(bindRoot, normalizedId) : normalizedId

        // The target in this action does not matter as long as it is
        // different than /var/dance-cache of course
        const target = "/var/cache-target";

        cacheMap[bindDir] = {
          id,
          target,
        };
      }
    }
  }

  return cacheMap;
}

export async function getCacheMap(opts: Opts): Promise<CacheMap> {
  try {
    const cacheMap = JSON.parse(opts["cache-map"]) as CacheMap;
    if (Object.keys(cacheMap).length !== 0) {
      // If cache-dir is specified, prepend it to each cache source path
      const cacheDir = opts["cache-dir"];
      if (cacheDir !== null && cacheDir !== '') {
        // Use Object.create(null) to prevent prototype pollution attacks
        const prefixedCacheMap: CacheMap = Object.create(null);
        for (const [source, options] of Object.entries(cacheMap)) {
          // Use path.basename to normalize the source key and prevent path traversal
          const normalizedSource = path.basename(source);
          const prefixedSource = path.join(cacheDir, normalizedSource);
          prefixedCacheMap[prefixedSource] = options;

          // Warn if the source key was modified by path.basename
          if (normalizedSource !== source) {
            warning(`cache-map key "${source}" was normalized to "${normalizedSource}" (path.basename applied for security)`);
          }
        }
        info(`cache-dir applied: cache paths will be under "${cacheDir}/"`);
        return prefixedCacheMap;
      }
      return cacheMap;
    }

    console.log(`No cache map provided. Trying to parse the Dockerfile to find the cache mount instructions...`);
    const cacheMapFromDockerfile = await getCacheMapFromDockerfile(opts["dockerfile"], opts["cache-dir"]);
    console.log(`Cache map parsed from Dockerfile: ${JSON.stringify(cacheMapFromDockerfile)}`);
    return cacheMapFromDockerfile;
  } catch (e) {
    throw new Error(`Failed to parse cache map. Expected JSON, got:\n${opts["cache-map"]}\n${e}`);
  }
}

export function getTargetPath(cacheOptions: CacheOptions): TargetPath {
  if (typeof cacheOptions === "string") {
    // only the target path is provided
    return cacheOptions;
  } else {
    // object is provided
    if ("target" in cacheOptions) {
      return cacheOptions.target;
    } else {
      throw new Error(`Expected the 'target' key in the cache options, got:\n${cacheOptions}`);
    }
  }
}

export function getUID(cacheOptions: CacheOptions): string {
  if (typeof cacheOptions === "string") {
    // only the target path is provided
    return "";
  } else {
    // object is provided
    if ("uid" in cacheOptions && cacheOptions.uid !== undefined) {
      return cacheOptions.uid.toString();
    } else {
      return "";
    }
  }
}

export function getGID(cacheOptions: CacheOptions): string {
  if (typeof cacheOptions === "string") {
    // only the target path is provided
    return "";
  } else {
    // object is provided
    if ("gid" in cacheOptions && cacheOptions.gid !== undefined) {
      return cacheOptions.gid.toString();
    } else {
      return "";
    }
  }
}

/**
 * Convert a cache options to a string that is passed to --mount=
 * @param CacheOptions The cache options to convert to a string
 */
export function getMountArgsString(cacheOptions: CacheOptions): string {
  if (typeof cacheOptions === "string") {
    // only the target path is provided
    return `type=cache,target=${cacheOptions}`;
  } else {
    // other options are provided
    const otherOptions = Object.entries(cacheOptions).map(([key, value]) => `${key}=${value}`).join(",");
    return `type=cache,${otherOptions}`;
  }
}

export function getBuilder(opts: Opts): string {
    return opts["builder"] == null || opts["builder"] == "" ? "default" : opts["builder"];
}

export function isDebug(opts: Opts): boolean {
    return opts["is-debug"] === true;
}

export function isRsyncMode(opts: Opts): boolean {
    return opts["rsync-mode"] === true;
}

// Default utility images
export const DEFAULT_UTILITY_IMAGE = "ghcr.io/containerd/busybox:latest";
export const RSYNC_UTILITY_IMAGE = "ghcr.io/daudcanugerah/cache-dance-rsync:latest";

/**
 * Get the appropriate utility image based on rsync-mode.
 * If rsync-mode is enabled and no custom utility-image is specified, use the rsync image.
 */
export function getUtilityImage(opts: Opts): string {
    const userSpecified = opts["utility-image"];
    const rsyncEnabled = isRsyncMode(opts);
    
    // If user specified a custom image, always use it
    if (userSpecified && userSpecified !== DEFAULT_UTILITY_IMAGE) {
        return userSpecified;
    }
    
    // If rsync-mode is enabled, use the rsync image
    if (rsyncEnabled) {
        return RSYNC_UTILITY_IMAGE;
    }
    
    // Default to busybox
    return DEFAULT_UTILITY_IMAGE;
}

/**
 * Generate a unique suffix from a path string for Docker image/container names.
 * Replaces special characters with dashes and normalizes the result.
 */
export function generateUniqueSuffix(pathStr: string): string {
    return pathStr.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

/**
 * Validate that a path is safe for use in file operations.
 * Prevents path traversal attacks by rejecting absolute paths and paths containing '..'.
 * @throws Error if the path is unsafe
 */
export function validateSafePath(pathStr: string, label: string): void {
    // Reject absolute paths
    if (path.isAbsolute(pathStr)) {
        throw new Error(`${label} must be a relative path, got absolute path: ${pathStr}`);
    }
    // Reject paths containing '..'
    const normalized = path.normalize(pathStr);
    if (normalized.startsWith('..') || normalized.includes(`${path.sep}..`)) {
        throw new Error(`${label} contains path traversal sequence: ${pathStr}`);
    }
    // Reject paths with shell metacharacters that could be used for injection
    const dangerousChars = /[;|&$`\\'"<>(){}[\]!#*?~]/;
    if (dangerousChars.test(pathStr)) {
        throw new Error(`${label} contains potentially dangerous characters: ${pathStr}`);
    }
}

/**
 * Sanitize a string for safe use in Dockerfile RUN instructions.
 * Escapes shell metacharacters to prevent command injection.
 */
export function sanitizeForDockerfile(value: string): string {
    // Only allow safe characters for mount options and paths
    // This is a whitelist approach - only alphanumeric, slash, dot, dash, underscore, equals, comma
    if (!/^[a-zA-Z0-9/._\-=,]+$/.test(value)) {
        throw new Error(`Unsafe characters in value for Dockerfile: ${value}`);
    }
    return value;
}

/**
 * Check if a path is within the workspace (relative and doesn't escape).
 * Used for debug inspection to prevent information disclosure.
 */
export function isPathWithinWorkspace(pathStr: string, workspaceRoot: string): boolean {
    const resolvedPath = path.resolve(workspaceRoot, pathStr);
    const normalizedWorkspace = path.resolve(workspaceRoot);
    return resolvedPath.startsWith(normalizedWorkspace + path.sep) || resolvedPath === normalizedWorkspace;
}
