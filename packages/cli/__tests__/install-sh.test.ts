import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../../..');
const installer = join(repoRoot, 'install.sh');

const runInstaller = (installDir: string, extraBin?: string) => {
  const path = extraBin === undefined ? process.env.PATH : `${extraBin}:${process.env.PATH}`;
  return Bun.spawnSync(['sh', installer], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AIO_PROXY_INSTALL_DIR: installDir,
      PATH: path,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
};

const fakeCurlDir = (root: string): string => {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    printf '%s\n' '#!/bin/sh' 'echo aio-proxy' > "$2"
    exit 0
  fi
  shift
done
exit 1
`,
  );
  chmodSync(join(bin, 'curl'), 0o755);
  return bin;
};

test('install.sh refuses to replace an unrelated aiop executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-install-collision-'));
  const installDir = join(root, 'bin');
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, 'aiop'), 'other-tool\n');
  try {
    const result = runInstaller(installDir, fakeCurlDir(root));
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout.toString()}${result.stderr.toString()}`).toContain('aiop');
    expect(Bun.file(join(installDir, 'aiop')).text()).resolves.toBe('other-tool\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('install.sh links aiop when the path is free', () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-install-free-'));
  const installDir = join(root, 'bin');
  mkdirSync(installDir, { recursive: true });
  try {
    const result = runInstaller(installDir, fakeCurlDir(root));
    expect(result.exitCode).toBe(0);
    expect(readlinkSync(join(installDir, 'aiop'))).toBe('aio-proxy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('install.sh refuses to replace an unrelated aiop symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-install-foreign-link-'));
  const installDir = join(root, 'bin');
  mkdirSync(installDir, { recursive: true });
  symlinkSync('other-tool', join(installDir, 'aiop'));
  try {
    const result = runInstaller(installDir, fakeCurlDir(root));
    expect(result.exitCode).not.toBe(0);
    expect(readlinkSync(join(installDir, 'aiop'))).toBe('other-tool');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('install.sh replaces its own previous aiop symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-install-ours-'));
  const installDir = join(root, 'bin');
  mkdirSync(installDir, { recursive: true });
  symlinkSync('aio-proxy', join(installDir, 'aiop'));
  try {
    const result = runInstaller(installDir, fakeCurlDir(root));
    expect(result.exitCode).toBe(0);
    expect(readlinkSync(join(installDir, 'aiop'))).toBe('aio-proxy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
