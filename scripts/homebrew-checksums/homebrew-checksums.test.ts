import { describe, expect, test } from 'bun:test';

import { buildHomebrewChecksums, tarballUrl } from './homebrew-checksums';

const PACKAGES = ['cli-darwin-arm64', 'cli-linux-x64'];
const VERSION = '9.8.7';

const bytesFor = (pkg: string) => new TextEncoder().encode(`tarball-of-${pkg}`);
const sha256For = (pkg: string) => new Bun.CryptoHasher('sha256').update(bytesFor(pkg)).digest('hex');
const packageOf = (url: string) => PACKAGES.find((pkg) => url.includes(`/@aio-proxy/${pkg}/`))!;

const build = (overrides: Partial<Parameters<typeof buildHomebrewChecksums>[0]> = {}) =>
  buildHomebrewChecksums({
    packages: PACKAGES,
    version: VERSION,
    fetchTarball: (url) => Promise.resolve(new Response(bytesFor(packageOf(url)))),
    wait: () => Promise.resolve(),
    log: () => {},
    ...overrides,
  });

describe('buildHomebrewChecksums', () => {
  test('hashes the bytes the registry serves, keyed by unscoped package name', async () => {
    const payload = await build();

    // The tap's formula keys off the unscoped name and pins a sha256 of exactly
    // the bytes `brew install` will download.
    expect(payload).toEqual({
      version: VERSION,
      checksums: {
        'cli-darwin-arm64': sha256For('cli-darwin-arm64'),
        'cli-linux-x64': sha256For('cli-linux-x64'),
      },
    });
  });

  test('requests the registry URL Homebrew will fetch', () => {
    expect(tarballUrl('cli-darwin-arm64', VERSION)).toBe(
      'https://registry.npmjs.org/@aio-proxy/cli-darwin-arm64/-/cli-darwin-arm64-9.8.7.tgz',
    );
  });

  // The whole reason this runs in its own job: npm's tarball reads lag publish by
  // minutes, per package. A 404 must be waited out, not reported as a failure.
  test('retries a tarball that is not on the CDN yet', async () => {
    let attempts = 0;
    const payload = await build({
      packages: ['cli-darwin-arm64'],
      fetchTarball: (url) => {
        attempts++;
        if (attempts < 3) return Promise.resolve(new Response('', { status: 404 }));
        return Promise.resolve(new Response(bytesFor(packageOf(url))));
      },
    });

    expect(attempts).toBe(3);
    expect(payload.checksums).toEqual({ 'cli-darwin-arm64': sha256For('cli-darwin-arm64') });
  });

  // One release died outright on a bare ECONNRESET, so a thrown fetch is the same
  // kind of transient as a 404 here.
  test('retries a network error the same way', async () => {
    let attempts = 0;
    const payload = await build({
      packages: ['cli-darwin-arm64'],
      fetchTarball: (url) => {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error('ECONNRESET'));
        return Promise.resolve(new Response(bytesFor(packageOf(url))));
      },
    });

    expect(attempts).toBe(2);
    expect(payload.checksums['cli-darwin-arm64']).toBe(sha256For('cli-darwin-arm64'));
  });

  test('gives up with the URL and reason once the retries are exhausted', async () => {
    const promise = build({
      packages: ['cli-darwin-arm64'],
      fetchTarball: () => Promise.resolve(new Response('', { status: 404 })),
    });

    await expect(promise).rejects.toThrow(/cli-darwin-arm64-9\.8\.7\.tgz is still unavailable.*HTTP 404/s);
  });

  // An empty payload would regenerate a formula with no bottles at all.
  test('fails before waiting when there are no platform packages', async () => {
    const promise = build({
      packages: [],
      fetchTarball: () => Promise.reject(new Error('should not have been called')),
    });

    await expect(promise).rejects.toThrow(/nothing to pin/);
  });
});
