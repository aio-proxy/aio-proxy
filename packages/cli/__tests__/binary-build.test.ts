import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../../..');

const hostSuffix = (): string => {
  const platform = process.platform === 'darwin' || process.platform === 'linux' ? process.platform : undefined;
  const architecture = process.arch === 'arm64' || process.arch === 'x64' ? process.arch : undefined;
  if (platform === undefined || architecture === undefined) {
    throw new Error(`Unsupported binary smoke platform: ${process.platform}-${process.arch}`);
  }
  return `${platform}-${architecture}`;
};

test('compiled platform package runs outside the workspace and includes its third-party notice', async () => {
  const suffix = hostSuffix();
  const build = Bun.spawnSync([process.execPath, 'packages/cli/scripts/build-binary.ts', suffix], {
    cwd: repoRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(`${build.stdout.toString()}${build.stderr.toString()}`).toContain(`${suffix}:`);
  expect(build.exitCode).toBe(0);

  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-binary-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'aio-proxy-binary-cwd-'));
  const packDir = mkdtempSync(join(tmpdir(), 'aio-proxy-binary-pack-'));
  try {
    const pack = Bun.spawnSync([process.execPath, 'pm', 'pack', '--destination', packDir], {
      cwd: join(repoRoot, 'npm', `cli-${suffix}`),
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(pack.exitCode).toBe(0);
    const [tarball] = await Array.fromAsync(new Bun.Glob('*.tgz').scan({ cwd: packDir, absolute: true }));
    expect(tarball).toBeDefined();
    const files = await new Bun.Archive(await Bun.file(tarball!).bytes()).files();
    const notice = await files.get('package/bin/THIRD_PARTY_NOTICES')?.text();
    expect(notice).toBeDefined();
    expect(notice!).toContain('Copyright (c) 2025 Mario Zechner');
    expect(notice!).toContain('Copyright (c) 2025-2026 Can Bölük');

    const result = Bun.spawnSync([join(repoRoot, 'npm', `cli-${suffix}`, 'bin', 'aio-proxy'), 'plugin', 'list'], {
      cwd,
      env: {
        ...process.env,
        AIO_PROXY_HOME: home,
        AIO_PROXY_LANG: undefined,
        LANG: 'en_US.UTF-8',
        LANGUAGE: undefined,
        LC_ALL: undefined,
        LC_MESSAGES: undefined,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const stdout = result.stdout.toString();
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('@aio-proxy/plugin-github-copilot');
    expect(stdout).toContain('@aio-proxy/plugin-openai-chatgpt');
    expect(stdout).toContain('@aio-proxy/plugin-google-antigravity');
    expect(stdout).toContain('@aio-proxy/plugin-kimi-code');
    expect(stdout).toContain('@aio-proxy/plugin-cursor');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
}, 120_000);
