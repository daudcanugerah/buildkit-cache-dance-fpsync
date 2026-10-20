# The BuildKit Cache Dance (Fork)

> **Note**: This is a fork of [`reproducible-containers/buildkit-cache-dance`](https://github.com/reproducible-containers/buildkit-cache-dance) with critical bug fixes.

Save `RUN --mount=type=cache` caches on GitHub Actions or other CI platforms

The BuildKit Cache Dance allows saving [`RUN --mount=type=cache`](https://docs.docker.com/build/guide/mounts/#add-a-cache-mount)
caches on GitHub Actions or other CI platforms by extracting the cache from the previous build and injecting it into the current build.

Use cases:

- apt-get (`/var/cache/apt`, `/var/lib/apt`)
- Go (`/root/.cache/go-build`, `/go/pkg/mod`)
- etc.

## Why this fork?

This fork includes critical bug fixes not present in the upstream repository:

- **Fix multiple caches overwriting each other** ([#39](https://github.com/reproducible-containers/buildkit-cache-dance/issues/39)): Uses unique Docker image/container names for each cache
- **Fix path traversal vulnerability**: Sanitizes cache id using `path.basename()` to prevent arbitrary file deletion
- **Fix double slash issue** ([#33](https://github.com/reproducible-containers/buildkit-cache-dance/issues/33)): Correctly handles cache ids starting with '/'
- **Add scratchDir cleanup**: Prevents leftover data from previous iterations
- **Improve cleanup reliability**: Moves Docker cleanup to `finally` blocks
- **Add debug mode**: `is-debug: true` enables verbose logging for troubleshooting cache issues
- **Single parallel build**: all caches are injected/extracted by one `docker buildx build` with one stage per cache (BuildKit runs them in parallel) instead of one sequential build per cache
- **fpsync support**: differential sync uses `fpsync` (fpart-driven parallel rsync) in both inject and extract, with rsync/cp fallbacks

## Examples

### apt-get GitHub Actions

Dockerfile:

```dockerfile
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN \
  --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  rm -f /etc/apt/apt.conf.d/docker-clean && \
  echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' >/etc/apt/apt.conf.d/keep-cache && \
  apt-get update && \
  apt-get install -y gcc
```

Action:

```yaml
---
name: Build
on:
  push:

jobs:
  Build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
        id: setup-buildx
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: Build

      - name: Cache
        uses: actions/cache@v4
        id: cache
        with:
          path: cache-mount
          key: cache-mount-${{ hashFiles('Dockerfile') }}

      - name: Restore Docker cache mounts
        uses: daudcanugerah/buildkit-cache-dance@v4
        with:
          builder: ${{ steps.setup-buildx.outputs.name }}
          cache-dir: cache-mount
          dockerfile: Dockerfile
          skip-extraction: ${{ steps.cache.outputs.cache-hit }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          cache-from: type=gha
          cache-to: type=gha,mode=max
          file: Dockerfile
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}

```

Real-world examples:

- <https://github.com/rootless-containers/slirp4netns/blob/v1.2.2/.github/workflows/release.yaml#L18-L36>
- <https://github.com/containers/fuse-overlayfs/blob/40e0f3c/.github/workflows/release.yaml#L17-L36>

## Understanding cache-dir

The `cache-dir` parameter is a critical concept for using this action with `actions/cache`. It specifies **the root directory on the host (GitHub Actions runner) where cache data is extracted to and injected from**.

### What cache-dir IS

- A "staging area" on the host filesystem where BuildKit cache mount contents are temporarily stored
- The directory that `actions/cache` should save/restore
- A bridge between BuildKit's internal cache volumes and the host filesystem

### What cache-dir IS NOT

- NOT the Docker container's internal paths like `/go/pkg/mod` or `/root/.cache/go-build`
- NOT the BuildKit internal cache volume itself

### How it works

```
┌─────────────────────────────────────────────────────────────────────────┐
│  GitHub Actions Runner (Host)                                           │
│                                                                         │
│   cache-dir (e.g., cache-mount/)                                        │
│   ├── go-mod/          ← extracted from BuildKit cache id="go-mod"      │
│   └── go-build/        ← extracted from BuildKit cache id="go-build"   │
│                                                                         │
│   actions/cache saves/restores this entire directory                    │
└─────────────────────────────────────────────────────────────────────────┘
                              ↑↓ extract/inject
┌─────────────────────────────────────────────────────────────────────────┐
│  BuildKit Cache Volumes (inside Docker)                                 │
│                                                                         │
│   id="go-mod"     → target="/go/pkg/mod"                                │
│   id="go-build"   → target="/root/.cache/go-build"                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Important: cache-dir must match actions/cache path

```yaml
- name: Cache
  uses: actions/cache@v4
  with:
    path: cache-mount        # ← This path
    key: cache-${{ hashFiles('Dockerfile') }}

- name: BuildKit Cache Dance
  uses: daudcanugerah/buildkit-cache-dance@v4
  with:
    cache-dir: cache-mount   # ← Must match the path above
```

When using `cache-map` with `cache-dir`, the cache-map keys are automatically prefixed with `cache-dir`. For example:

```yaml
cache-dir: cache-mount
cache-map: |
  {
    "go-mod": { "target": "/go/pkg/mod", "id": "go-mod" }
  }
```

Results in cache being stored at `cache-mount/go-mod/` on the host.

## CacheMap Options

If you require more fine grained control you can manually specify a JSON formatted `cache-map`. The keys specify the paths on the Docker builder host to use as the bind source and the string value provides the cache mount `target` within the Docker build:

```yaml
      - name: Restore Docker cache mounts
        uses: daudcanugerah/buildkit-cache-dance@v4
        with:
          builder: ${{ steps.setup-buildx.outputs.name }}
          cache-map: |
            {
              "var-cache-apt": "/var/cache/apt",
              "var-lib-apt": "/var/lib/apt"
            }
          skip-extraction: ${{ steps.cache.outputs.cache-hit }}
```

Alternatively, you can provide a JSON object with additional options that should be passed to `--mount=type=cache` in the values `cache-map` JSON. The `target` path must be present in the object as a property.

```yaml
      - name: Restore Docker cache mounts
        uses: daudcanugerah/buildkit-cache-dance@v4
        with:
          builder: ${{ steps.setup-buildx.outputs.name }}
          cache-map: |
            {
              "var-cache-apt": {
                "target": "/var/cache/apt",
                "id": "1"
              },
              "var-lib-apt": "/var/lib/apt"
            }
          skip-extraction: ${{ steps.cache.outputs.cache-hit }}
```

## CLI Usage

In other CI systems, you can run the script directly via `node`:

```shell
curl -LJO https://github.com/daudcanugerah/buildkit-cache-dance/archive/refs/tags/v4.0.0.tar.gz
tar xvf buildkit-cache-dance-4.0.0.tar.gz
```

During injection:

```shell
node  ./buildkit-cache-dance-4.0.0/dist/index.js --cache-map '{"var-cache-apt": "/var/cache/apt", "var-lib-apt": "/var/lib/apt"}'
```

After build during extraction:

```shell
node  ./buildkit-cache-dance-4.0.0/dist/index.js --extract --cache-map '{"var-cache-apt": "/var/cache/apt", "var-lib-apt": "/var/lib/apt"}'
```

Here are the available options:

```
build-cache-dance [options]
Save 'RUN --mount=type=cache' caches on GitHub Actions or other CI platforms

Options:
  --extract          Extract the cache from the docker container (extract step).
                     Otherwise, inject the cache (main step)
  --cache-map        JSON map of host paths to cache mount options.
                     Keys = host directories, Values = target path or mount options object
  --dockerfile       Dockerfile for auto-discovery of cache-map. Default: 'Dockerfile'
  --cache-dir        Root directory on host for cache storage. When specified:
                     - With auto-discovery: caches stored at <cache-dir>/<cache-id>/
                     - With cache-map: keys are prefixed with <cache-dir>/
                     This should match the path used by actions/cache.
  --scratch-dir      Temporary directory for action processing. Default: 'scratch'
  --skip-extraction  Skip cache extraction (use when cache-hit). Default: 'false'
  --builder          Name of the buildx builder. Default: 'default'
  --is-debug         Enable verbose debug logs. Default: 'false'
   --rsync-mode       Use rsync for differential sync (faster for large caches). Default: 'true'
   --help             Show this help
```

### One build, all caches

All caches are handled by a **single `docker buildx build` per phase** instead of one build per cache:

- **Inject**: the generated `Dancefile.inject` contains one build stage per cache (each writing into its own `RUN --mount=type=cache`), and BuildKit runs these stages **in parallel**. Each cache source is passed as a [named build context](https://docs.docker.com/build/building/context/#named-contexts) (`--build-context`), so the build context stays small.
- **Extract**: the generated `Dancefile.extract` copies every cache mount into one merged tree and exports it as a single tar stream, which host-side `tar` unpacks; each snapshot is then swapped into place with an atomic rename.

Requirements: Dockerfile syntax ≥ 1.4 and buildx ≥ 0.8 (used by `docker/setup-buildx-action@v3` and any recent Docker). Caches that share the same cache id (`sharing=locked`) still serialize inside BuildKit; caches with distinct ids run fully in parallel.


## Debugging

When cache is not working as expected, enable debug mode to get detailed logs:

```yaml
- name: BuildKit Cache Dance (inject; extract in post)
  uses: daudcanugerah/buildkit-cache-dance@v4
  with:
    builder: ${{ steps.setup-buildx.outputs.name }}
    cache-dir: cache-mount
    dockerfile: Dockerfile
    cache-map: |
      {
        "go-mod":  { "target": "/go/pkg/mod", "id": "go-mod" },
        "go-build":{ "target": "/root/.cache/go-build", "id": "go-build" }
      }
    skip-extraction: false
    is-debug: true
```

Debug mode outputs:

1. **Input values dump**: All options with resolved absolute paths
2. **Parsed cache-map**: The actual cache map being used
3. **Generated mount args**: Shows exactly what `--mount=` arguments are generated (critical for verifying `id=` is included)
4. **Directory inspection**: Size and contents of cache directories before/after inject/extract
5. **Docker commands**: All docker commands being executed

This helps diagnose common issues:

- Path mismatches between Dockerfile and cache-map
- Missing `id=` in mount arguments (causes cache miss)
- Empty cache directories after extraction
- Cache not being saved by `actions/cache`

## Performance Optimization

### skip-extraction

Use `skip-extraction: true` to skip the Post extract step (~60 seconds) when cache updates are not needed.

- **Inject (Main step)**: Always runs (restores cache to BuildKit)
- **Extract (Post step)**: Skipped when `skip-extraction: true`

**Recommended**: Enable on non-main branches to save CI time while still benefiting from cached builds.

```yaml
- name: BuildKit Cache Dance (inject; extract in post)
  uses: daudcanugerah/buildkit-cache-dance@v4
  with:
    builder: ${{ steps.setup-buildx.outputs.name }}
    cache-dir: cache-mount
    cache-map: |
      {
        "go-mod":  { "target": "/go/pkg/mod", "id": "go-mod" },
        "go-build":{ "target": "/root/.cache/go-build", "id": "go-build" }
      }
    # Skip extraction on non-main branches (saves ~60s)
    # Cache is still restored and used, just not updated
    skip-extraction: ${{ github.ref != 'refs/heads/main' }}
```

## Releases

### v1

v1 follows the original design of [`overmindtech/buildkit-cache-dance`](https://github.com/overmindtech/buildkit-cache-dance/tree/306d31a77191f643c0c4a95083f36c6ddccb4a16).

v1 is composed of two actions:

- `reproducible-containers/buildkit-cache-dance/inject@v1.0.1`
- `reproducible-containers/buildkit-cache-dance/extract@v1.0.1`

See the [`releases/v1`](https://github.com/reproducible-containers/buildkit-cache-dance/tree/releases/v1) branch.

### v2

v2 is composed of the single `reproducible-containers/buildkit-cache-dance` action.

### v3

Rewrote the action in TypeScript and adds support for `cache-map` that gets a string of files that need to be injected as a JSON string. This makes it possible to inject multiple directories in one call and simplifies the usage.

This release also makes it possible to run the script outside GitHub Actions in other CI platforms or locally using command line arguments.

### v4 (this fork)

This version is maintained in this fork (`daudcanugerah/buildkit-cache-dance`) and includes:

- **Fix cache-dir being ignored with explicit cache-map**: When both `cache-dir` and `cache-map` were specified, `cache-dir` was not applied to cache paths, causing caches to be saved to the repository root instead of the specified directory
- Critical bug fixes for multiple cache handling and path traversal issues
- Improved cleanup reliability with `try...finally` blocks
- Updated dependencies (parcel, typescript, vitest, etc.)
- Security improvements
- **Debug mode** (`is-debug: true`) for troubleshooting cache issues
- **Rsync mode** (`rsync-mode: true`) for differential sync - much faster for large caches on subsequent runs

**Usage:**

```yaml
uses: daudcanugerah/buildkit-cache-dance@v4
```

## Rsync Mode (Performance Optimization)

For large caches (like Go modules), the default `cp -R` full copy can take 1-4 minutes on each run. Enable `rsync-mode` for differential sync that only copies changed files:

```yaml
- name: BuildKit Cache Dance
  uses: daudcanugerah/buildkit-cache-dance@v4
  with:
    cache-dir: cache-mount
    rsync-mode: true   # Enable differential sync
    is-debug: true
```

### How it works

Each phase (inject / extract) runs a **single `docker buildx build`** whose generated Dockerfile contains one stage per cache; BuildKit executes these stages in parallel.

| Mode | Command (per stage) | Performance |
|------|---------|-------------|
| Default (`rsync-mode: false`) | `cp -p -R` | Full copy every time |
| Rsync (`rsync-mode: true`) | `fpsync` (parallel rsync, falls back to `rsync -a --ignore-existing`) | Only copies new/changed files, parallel chunks |

### Performance comparison

| Cache Size | First Run | Subsequent Runs (cp) | Subsequent Runs (rsync) |
|------------|-----------|----------------------|-------------------------|
| 500 MB | ~30s | ~30s | **~5s** |
| 1 GB | ~60s | ~60s | **~10s** |

### Utility image

When `rsync-mode: true` is enabled, the action automatically uses `ghcr.io/daudcanugerah/cache-dance-rsync:latest` (Alpine 3.23 with rsync pre-installed) instead of the default busybox image. You can override this with a custom `utility-image` if needed.

## Development Notes

### Validate Dist (CI)

The unit-tests workflow runs `pnpm i` (which runs `prepare` → build) and then checks that `dist/` has no uncommitted changes. **After changing source, you must build and commit `dist/`** or the "Validate Dist" step will fail:

```bash
cd buildkit-cache-dance
pnpm run build
git add dist/
git commit -m "chore(buildkit-cache-dance): update dist"
```

### Why `@actions/core` is pinned to 1.x

The `@actions/core` package is intentionally pinned to version 1.8.0. Starting from version 2.x, `@actions/core` depends on `undici` for HTTP operations. When bundled with Parcel, `undici` causes runtime errors due to its use of Node.js native modules that don't bundle correctly.

Since this action uses Parcel to create a single bundled `dist/index.js` file, we must keep `@actions/core` at 1.x to maintain compatibility.

## Acknowledgement

- Thanks to [Alexander Pravdin](https://github.com/speller) for the basic idea in [this comment](https://github.com/moby/buildkit/issues/1512).
- Thanks to the authors of the original [`overmindtech/buildkit-cache-dance`](https://github.com/overmindtech/buildkit-cache-dance).
