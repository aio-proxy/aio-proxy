import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
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

test('compiled binary can read embedded agent adapter files after source dist is hidden', async () => {
  const work = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-embed-'));
  const outfile = join(work, 'read-agent-assets');
  const hidden = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-dist-hidden-'));
  const distDirs = [join(repoRoot, 'packages/opencode-provider/dist'), join(repoRoot, 'packages/pi-provider/dist')];
  const hiddenDirs = distDirs.map((_, index) => join(hidden, String(index)));
  const entrypoint = join(import.meta.dir, 'read-agent-assets.gen.ts');
  try {
    const build = await Bun.build({
      entrypoints: [entrypoint],
      files: {
        [entrypoint]: [
          'import opencodeProvider from "@aio-proxy/opencode-provider/artifact" with { type: "file" };',
          'import officialPiProvider from "@aio-proxy/pi-provider/official-pi-artifact" with { type: "file" };',
          'import ompProvider from "@aio-proxy/pi-provider/omp-artifact" with { type: "file" };',
          'const paths = [opencodeProvider, officialPiProvider, ompProvider];',
          'for (const path of paths) {',
          '  const file = Bun.file(path);',
          '  if (!(await file.exists())) throw new Error(`missing ${path}`);',
          '  const bytes = await file.bytes();',
          '  if (bytes.byteLength === 0) throw new Error(`empty ${path}`);',
          '  console.log(path);',
          '}',
          '',
        ].join('\n'),
      },
      compile: { outfile },
    });
    if (!build.success) throw new Error(build.logs.map(String).join('\n') || 'compile failed');

    for (const [index, dir] of distDirs.entries()) renameSync(dir, hiddenDirs[index]!);
    expect(existsSync(join(repoRoot, 'packages/opencode-provider/dist/index.js'))).toBe(false);
    expect(existsSync(join(repoRoot, 'packages/pi-provider/dist/official-pi.js'))).toBe(false);
    expect(existsSync(join(repoRoot, 'packages/pi-provider/dist/omp.js'))).toBe(false);

    const result = Bun.spawnSync([outfile], { cwd: work, stderr: 'pipe', stdout: 'pipe' });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split('\n')).toHaveLength(3);
  } finally {
    for (const [index, dir] of distDirs.entries()) {
      const parked = hiddenDirs[index]!;
      if (existsSync(parked)) {
        rmSync(dir, { recursive: true, force: true });
        renameSync(parked, dir);
      }
    }
    rmSync(work, { recursive: true, force: true });
    rmSync(hidden, { recursive: true, force: true });
  }
}, 120_000);
