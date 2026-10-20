import { describe, it, expect } from 'vitest';
import {
    toCacheEntries,
    sourceContextName,
    buildInjectDockerfile,
    buildExtractDockerfile,
    buildxContextArgs,
    CacheEntry,
} from '../src/dancefile.js';

const RSYNC_IMAGE = 'ghcr.io/daudcanugerah/cache-dance-rsync:latest';
const BUSYBOX_IMAGE = 'ghcr.io/containerd/busybox:latest';

const twoCaches = {
    'var-cache-apt': { target: '/var/cache/apt', id: '1' },
    'var-lib-apt': '/var/lib/apt',
} as const;

describe('toCacheEntries', () => {
    it('creates one entry per cache in map order', () => {
        const entries = toCacheEntries(twoCaches as any);
        expect(entries).toHaveLength(2);
        expect(entries[0].source).toBe('var-cache-apt');
        expect(entries[1].source).toBe('var-lib-apt');
    });

    it('prefixes names with an index to guarantee uniqueness', () => {
        // "a/b" and "a-b" normalize to the same suffix; the index disambiguates
        const entries = toCacheEntries({
            'a/b': '/target-a',
            'a-b': '/target-b',
        } as any);
        expect(entries[0].name).not.toBe(entries[1].name);
        expect(entries[0].name).toMatch(/^c0-/);
        expect(entries[1].name).toMatch(/^c1-/);
    });

    it('produces Dockerfile-safe stage names', () => {
        const entries = toCacheEntries({ './weird/path/with:chars': '/t' } as any);
        // Docker stage names allow [a-zA-Z0-9._-]; reject everything else
        for (const entry of entries) {
            expect(entry.name).toMatch(/^[a-zA-Z0-9._-]+$/);
        }
    });
});

describe('buildInjectDockerfile', () => {
    it('declares the syntax directive for named build contexts support', () => {
        const content = buildInjectDockerfile(toCacheEntries(twoCaches as any), BUSYBOX_IMAGE, true);
        expect(content).toContain('# syntax=docker/dockerfile:1.4');
    });

    it('writes one stage per cache plus a final inject stage', () => {
        const entries = toCacheEntries(twoCaches as any);
        const content = buildInjectDockerfile(entries, BUSYBOX_IMAGE, true);
        for (const entry of entries) {
            expect(content).toContain(`FROM ${BUSYBOX_IMAGE} AS ${entry.name}`);
            expect(content).toContain(`COPY --from=${entry.name} /buildstamp /inject-${entry.name}`);
        }
        expect(content).toContain('AS inject');
    });

    it('binds each cache source through its named build context', () => {
        const entries = toCacheEntries(twoCaches as any);
        const content = buildInjectDockerfile(entries, BUSYBOX_IMAGE, true);
        for (const entry of entries) {
            expect(content).toContain(`--mount=type=bind,from=${sourceContextName(entry)},source=.,target=/var/dance-cache`);
        }
    });

    it('uses the cache mount args in each stage', () => {
        const content = buildInjectDockerfile(toCacheEntries(twoCaches as any), BUSYBOX_IMAGE, true);
        expect(content).toContain('--mount=type=cache,target=/var/cache/apt,id=1');
        expect(content).toContain('--mount=type=cache,target=/var/lib/apt');
    });

    it('uses fpsync with rsync fallback when rsync mode is on', () => {
        const content = buildInjectDockerfile(toCacheEntries(twoCaches as any), RSYNC_IMAGE, true);
        expect(content).toContain('command -v fpsync');
        expect(content).toContain('--ignore-existing -H');
        expect(content).toContain('rsync -a --ignore-existing');
    });

    it('uses cp -p -R when rsync mode is off', () => {
        const content = buildInjectDockerfile(toCacheEntries(twoCaches as any), BUSYBOX_IMAGE, false);
        expect(content).toContain('cp -p -R /var/dance-cache/. /var/cache/apt');
        expect(content).not.toContain('fpsync');
        expect(content).not.toContain('rsync');
    });

    it('appends chown when uid/gid are set', () => {
        const caches = {
            'src': { target: '/root/.cache/go-build', uid: '1000', gid: '1000' },
        };
        const content = buildInjectDockerfile(toCacheEntries(caches as any), BUSYBOX_IMAGE, false);
        expect(content).toContain('chown -R 1000:1000 /root/.cache/go-build');
        expect(content).toContain('|| true');
    });
});

describe('buildExtractDockerfile', () => {
    it('writes one stage per cache plus a final scratch stage nesting each /out by stage name', () => {
        const entries = toCacheEntries(twoCaches as any);
        const content = buildExtractDockerfile(entries, RSYNC_IMAGE, true);
        for (const entry of entries) {
            expect(content).toContain(`FROM ${RSYNC_IMAGE} AS ${entry.name}`);
            expect(content).toContain(`COPY --from=${entry.name} /out /${entry.name}/`);
        }
        expect(content).toContain('FROM scratch AS extract');
    });

    it('uses fpsync when available with cp -a fallback, tolerating failures', () => {
        const content = buildExtractDockerfile(toCacheEntries(twoCaches as any), RSYNC_IMAGE, true);
        expect(content).toContain('command -v fpsync');
        expect(content).toContain('cp -a /var/cache/apt/. /out/');
        expect(content).toContain('|| true');
    });

    it('uses only cp -a when rsync mode is off', () => {
        const content = buildExtractDockerfile(toCacheEntries(twoCaches as any), BUSYBOX_IMAGE, false);
        expect(content).toContain('cp -a /var/lib/apt/. /out/');
        expect(content).not.toContain('fpsync');
    });
});

describe('buildxContextArgs', () => {
    it('emits --build-context pairs mapping context names to sources', () => {
        const entries = toCacheEntries(twoCaches as any) as CacheEntry[];
        const args = buildxContextArgs(entries);
        expect(args).toEqual([
            '--build-context', `${sourceContextName(entries[0])}=var-cache-apt`,
            '--build-context', `${sourceContextName(entries[1])}=var-lib-apt`,
        ]);
    });

    it('is empty for no caches', () => {
        expect(buildxContextArgs([])).toEqual([]);
    });
});
