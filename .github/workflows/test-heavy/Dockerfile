# Heavy pnpm-install test for buildkit-cache-dance
# Installs many large packages (electron, sharp, next, playwright, swc...)
# with the pnpm content-addressable store on a BuildKit cache mount.
# The cache-dance action injects a previously saved store into /pnpm/store.
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app

# Route the pnpm store to the cache-mounted directory
ENV npm_config_store_dir=/pnpm/store

COPY package.json pnpm-lock.yaml ./

RUN --mount=type=cache,target=/pnpm/store,sharing=locked,id=pnpm-store \
  pnpm install --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store \
  && test "$(du -sm /pnpm/store | cut -f1)" -gt 1000 \
  && echo "heavy pnpm install OK: store=$(du -sm /pnpm/store | cut -f1)MB, packages=$(ls node_modules/.pnpm | wc -l)"
