import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// The installer itself lives in website/docs/public/install.sh because rspress
// copies that directory verbatim to the site root; a colocated .ts would be
// published alongside it, so the test lives here instead.
const INSTALLER = join(import.meta.dir, '..', '..', 'website', 'docs', 'public', 'install.sh');

const VERSION = '9.8.7';
const BINARY = 'fake-aio-proxy-binary';

type Registry = {
  readonly url: string;
  readonly paths: string[];
  stop: () => void;
};

/** A .tgz laid out the way `npm pack` publishes npm/cli-*: package/bin/aio-proxy. */
const packTarball = async (entries: Record<string, string>): Promise<ArrayBuffer> => {
  const dir = await fs.mkdtemp(join(await fs.realpath('/tmp'), 'aio-proxy-pack-'));
  for (const [path, contents] of Object.entries(entries)) {
    await fs.mkdir(join(dir, path, '..'), { recursive: true });
    await Bun.write(join(dir, path), contents);
  }
  const tgz = join(dir, 'out.tgz');
  const proc = Bun.spawn(['tar', '-czf', tgz, '-C', dir, 'package'], { stdout: 'ignore', stderr: 'pipe' });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return await Bun.file(tgz).arrayBuffer();
};

const serveRegistry = (tarball: ArrayBuffer | undefined): Registry => {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      paths.push(pathname);
      if (pathname === '/-/package/aio-proxy/dist-tags') {
        return new Response(`{"latest":"${VERSION}","next":"10.0.0-beta.1"}`);
      }
      if (pathname.endsWith('.tgz') && tarball !== undefined) {
        return new Response(tarball);
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { url: server.url.origin, paths, stop: () => void server.stop(true) };
};

/**
 * Runs the installer with `uname`/`ldd` shadowed on PATH, so one host can exercise
 * every platform branch. Nothing here executes the downloaded binary.
 */
const runInstaller = async (options: {
  readonly registry: string;
  readonly unameS: string;
  readonly unameM: string;
  readonly ldd?: string;
}) => {
  const root = await fs.mkdtemp(join(await fs.realpath('/tmp'), 'aio-proxy-install-'));
  const shim = join(root, 'shim');
  const installDir = join(root, 'bin');
  await fs.mkdir(shim, { recursive: true });
  const writeShim = async (name: string, body: string) => {
    const path = join(shim, name);
    await Bun.write(path, `#!/bin/sh\n${body}\n`);
    await fs.chmod(path, 0o755);
  };
  await writeShim('uname', `case "$1" in\n  -s) echo "${options.unameS}" ;;\n  -m) echo "${options.unameM}" ;;\nesac`);
  await writeShim('ldd', `echo "${options.ldd ?? 'ldd (GNU libc) 2.36'}"`);

  const proc = Bun.spawn(['sh', INSTALLER], {
    env: {
      PATH: `${shim}:${process.env['PATH'] ?? ''}`,
      HOME: root,
      AIO_PROXY_REGISTRY: options.registry,
      AIO_PROXY_INSTALL_DIR: installDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const installed = await Bun.file(join(installDir, 'aio-proxy'))
    .text()
    .catch(() => undefined);
  const aiop = await fs.readlink(join(installDir, 'aiop')).catch(() => undefined);
  return { exitCode, stdout, stderr, installed, aiop, installDir };
};

describe('install.sh', () => {
  let registry: Registry;

  beforeAll(async () => {
    registry = serveRegistry(await packTarball({ 'package/bin/aio-proxy': BINARY }));
  });
  afterAll(() => registry.stop());

  test('resolves the published version and installs the binary from its npm tarball', async () => {
    registry.paths.length = 0;
    const result = await runInstaller({ registry: registry.url, unameS: 'Linux', unameM: 'x86_64' });

    expect(result.exitCode).toBe(0);
    // The dist-tag lookup names the version, and the tarball URL is the one the
    // Homebrew tap and `aio-proxy upgrade` also fetch (see binaryTarballUrl).
    expect(registry.paths).toEqual([
      '/-/package/aio-proxy/dist-tags',
      `/@aio-proxy/cli-linux-x64/-/cli-linux-x64-${VERSION}.tgz`,
    ]);
    // The bytes that land on disk are the ones inside package/bin/aio-proxy.
    expect(result.installed).toBe(BINARY);
    expect(result.aiop).toBe('aio-proxy');
  });

  test('maps aarch64 and Darwin onto the published package suffixes', async () => {
    registry.paths.length = 0;
    const result = await runInstaller({ registry: registry.url, unameS: 'Darwin', unameM: 'aarch64' });

    expect(result.exitCode).toBe(0);
    expect(registry.paths.at(-1)).toBe(`/@aio-proxy/cli-darwin-arm64/-/cli-darwin-arm64-${VERSION}.tgz`);
  });

  // The published npm packages carry glibc builds; the musl targets in
  // build-binary.ts are Docker-only, so installing one here would leave an
  // executable that cannot start.
  test('refuses musl Linux instead of installing a glibc binary', async () => {
    registry.paths.length = 0;
    const result = await runInstaller({
      registry: registry.url,
      unameS: 'Linux',
      unameM: 'x86_64',
      ldd: 'musl libc (x86_64)',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('ghcr.io/aio-proxy/aio-proxy');
    expect(result.installed).toBeUndefined();
    expect(registry.paths).toEqual([]);
  });

  test('refuses an architecture with no published package', async () => {
    registry.paths.length = 0;
    const result = await runInstaller({ registry: registry.url, unameS: 'Linux', unameM: 'ppc64le' });

    expect(result.exitCode).not.toBe(0);
    expect(result.installed).toBeUndefined();
    expect(registry.paths).toEqual([]);
  });

  test('does not install anything when the tarball lacks bin/aio-proxy', async () => {
    const bad = serveRegistry(await packTarball({ 'package/package.json': '{}' }));
    try {
      const result = await runInstaller({ registry: bad.url, unameS: 'Linux', unameM: 'x86_64' });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('missing bin/aio-proxy');
      expect(result.installed).toBeUndefined();
    } finally {
      bad.stop();
    }
  });

  test('fails loudly when the platform package is not on the registry', async () => {
    const empty = serveRegistry(undefined);
    try {
      const result = await runInstaller({ registry: empty.url, unameS: 'Linux', unameM: 'x86_64' });

      expect(result.exitCode).not.toBe(0);
      expect(result.installed).toBeUndefined();
    } finally {
      empty.stop();
    }
  });
});
