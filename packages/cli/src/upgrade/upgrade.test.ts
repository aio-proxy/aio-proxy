import { expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isPathInDirectory, resolveManagedRestartExec, resolveUpgradeMethod, resolveUpgradeTargetFrom } from './detect';

test('isPathInDirectory: lexical match', () => {
  expect(isPathInDirectory('/opt/bun/bin/aio-proxy', '/opt/bun/bin')).toBe(true);
  expect(isPathInDirectory('/usr/local/bin/aio-proxy', '/opt/bun/bin')).toBe(false);
});

test('isPathInDirectory: resolves symlinked binary (Homebrew Cellar)', () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-brew-'));
  const cellarBin = join(root, 'Cellar/aio-proxy/1.0.0/bin');
  const optBin = join(root, 'opt/aio-proxy/bin');
  mkdirSync(cellarBin, { recursive: true });
  mkdirSync(join(root, 'opt/aio-proxy'), { recursive: true });
  writeFileSync(join(cellarBin, 'aio-proxy'), '#!/bin/sh\n');
  symlinkSync(cellarBin, optBin);
  // PATH 解析到 opt 软链目录，词法不落在 Cellar，realpath 兜底应判 true
  expect(isPathInDirectory(join(optBin, 'aio-proxy'), cellarBin)).toBe(true);
});

test('resolveUpgradeMethod: priority brew > bun > npm > pnpm', () => {
  const dirs = { brew: '/brew/bin', bun: '/bun/bin', npm: '/npm/bin', pnpm: '/pnpm/bin' };
  expect(resolveUpgradeMethod('/brew/bin/aio-proxy', dirs)).toBe('brew');
  expect(resolveUpgradeMethod('/bun/bin/aio-proxy', { bun: '/bun/bin', npm: '/npm/bin' })).toBe('bun');
  expect(resolveUpgradeMethod('/npm/bin/aio-proxy', { npm: '/npm/bin', pnpm: '/pnpm/bin' })).toBe('npm');
  expect(resolveUpgradeMethod('/pnpm/bin/aio-proxy', { pnpm: '/pnpm/bin' })).toBe('pnpm');
  expect(resolveUpgradeMethod('/home/u/.local/bin/aio-proxy', dirs)).toBe('binary');
});

import { NPM_REGISTRY } from './constants';
import {
  buildBunInstallArgs,
  buildHomebrewUpdateArgs,
  buildNpmInstallArgs,
  buildPnpmInstallArgs,
  runPackageManagerUpgrade,
} from './methods';

test('buildBunInstallArgs pins registry and version', () => {
  expect(buildBunInstallArgs('1.2.3', NPM_REGISTRY)).toEqual([
    'add',
    '-g',
    `--registry=${NPM_REGISTRY}`,
    'aio-proxy@1.2.3',
  ]);
});
test('buildNpmInstallArgs pins registry and version', () => {
  expect(buildNpmInstallArgs('1.2.3', NPM_REGISTRY)).toEqual([
    'install',
    '-g',
    `--registry=${NPM_REGISTRY}`,
    'aio-proxy@1.2.3',
  ]);
});
test('buildPnpmInstallArgs pins registry and version', () => {
  expect(buildPnpmInstallArgs('1.2.3', NPM_REGISTRY)).toEqual([
    'add',
    '-g',
    `--registry=${NPM_REGISTRY}`,
    'aio-proxy@1.2.3',
  ]);
});
test('buildHomebrewUpdateArgs switches on force', () => {
  expect(buildHomebrewUpdateArgs(false)).toEqual(['upgrade', 'aio-proxy/tap/aio-proxy']);
  expect(buildHomebrewUpdateArgs(true)).toEqual(['reinstall', 'aio-proxy/tap/aio-proxy']);
});

import { existsSync, readFileSync } from 'node:fs';

import { binaryTarballUrl, replaceBinaryForUpdate, sweepStaleBackups } from './binary';

test('replaceBinaryForUpdate rolls back when verify fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-bin-'));
  const target = join(root, 'aio-proxy');
  const temp = join(root, 'aio-proxy.new');
  const backup = join(root, 'aio-proxy.1.2.bak');
  writeFileSync(target, 'OLD');
  writeFileSync(temp, 'NEW');
  const res = await replaceBinaryForUpdate({
    targetPath: target,
    tempPath: temp,
    backupPath: backup,
    expectedVersion: '9.9.9',
    verify: async () => ({ ok: false }),
  });
  expect(res.ok).toBe(false);
  expect(readFileSync(target, 'utf8')).toBe('OLD'); // 回滚到旧二进制
  expect(existsSync(temp)).toBe(false);
});

test('replaceBinaryForUpdate swaps in new binary when verify ok', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-bin-'));
  const target = join(root, 'aio-proxy');
  const temp = join(root, 'aio-proxy.new');
  writeFileSync(target, 'OLD');
  writeFileSync(temp, 'NEW');
  const res = await replaceBinaryForUpdate({
    targetPath: target,
    tempPath: temp,
    backupPath: join(root, 'aio-proxy.1.2.bak'),
    expectedVersion: '1.0.0',
    verify: async () => ({ ok: true, actual: '1.0.0' }),
  });
  expect(res.ok).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe('NEW');
});

test('replaceBinaryForUpdate rolls back and rethrows when verify throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-bin-'));
  const target = join(root, 'aio-proxy');
  const temp = join(root, 'aio-proxy.new');
  writeFileSync(target, 'OLD');
  writeFileSync(temp, 'NEW');
  await expect(
    replaceBinaryForUpdate({
      targetPath: target,
      tempPath: temp,
      backupPath: join(root, 'aio-proxy.1.2.bak'),
      expectedVersion: '1.0.0',
      // A corrupt/wrong-format download makes Bun.spawn reject rather than
      // return { ok:false }; that must still restore the old binary.
      verify: async () => {
        throw new Error('spawn EFTYPE');
      },
    }),
  ).rejects.toThrow('spawn EFTYPE');
  expect(readFileSync(target, 'utf8')).toBe('OLD'); // 回滚到旧二进制，未把坏文件留在目标路径
  expect(existsSync(join(root, 'aio-proxy.1.2.bak'))).toBe(false); // 备份已还原
});

test('binaryTarballUrl points at the npm per-platform package (same as Homebrew tap)', () => {
  expect(binaryTarballUrl('https://registry.npmjs.org/', 'darwin-arm64', '1.2.3')).toBe(
    'https://registry.npmjs.org/@aio-proxy/cli-darwin-arm64/-/cli-darwin-arm64-1.2.3.tgz',
  );
  // A registry without a trailing slash still yields a well-formed URL.
  expect(binaryTarballUrl('https://r.example.com', 'linux-x64', '0.9.0')).toBe(
    'https://r.example.com/@aio-proxy/cli-linux-x64/-/cli-linux-x64-0.9.0.tgz',
  );
});

test('sweepStaleBackups removes only timestamped .bak siblings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-sweep-'));
  const target = join(root, 'aio-proxy');
  writeFileSync(target, 'x');
  writeFileSync(join(root, 'aio-proxy.123.456.bak'), 'x');
  writeFileSync(join(root, 'aio-proxy.unrelated.txt'), 'x');
  await sweepStaleBackups(target);
  expect(existsSync(join(root, 'aio-proxy.123.456.bak'))).toBe(false);
  expect(existsSync(join(root, 'aio-proxy.unrelated.txt'))).toBe(true);
});

import { fetchLatestVersion } from './registry';

test('fetchLatestVersion reads version from registry /latest', async () => {
  const fake = (async () => Response.json({ version: '2.3.4' })) as unknown as typeof fetch;
  expect(await fetchLatestVersion(NPM_REGISTRY, fake)).toBe('2.3.4');
});

test('fetchLatestVersion throws on non-ok', async () => {
  const fake = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
  await expect(fetchLatestVersion(NPM_REGISTRY, fake)).rejects.toThrow();
});

import { CliExit, EXIT } from '../exit';
import { resolveNewAgentBinary } from './agent-post-upgrade-process';
import type { AgentPostUpgradePayload } from './post-upgrade-agents';
import { runUpgradeCommand, type UpgradeDeps } from './upgrade';

const PAYLOAD = {
  format: 1,
  targets: [
    {
      target: 'opencode',
      managedDir: '/tmp/opencode/plugins/aio-proxy',
      adjacentEntry: '/tmp/opencode/plugins/aio-proxy.js',
    },
  ],
} as const satisfies AgentPostUpgradePayload;

const bunTarget = {
  method: 'bun' as const,
  command: '/usr/bin/bun',
  bin: '/usr/bin/aio-proxy',
};
const makeDeps = (overrides: Partial<UpgradeDeps> = {}): UpgradeDeps => ({
  resolveTarget: async () => bunTarget,
  fetchLatest: async () => '2.0.0',
  currentVersion: '1.0.0',
  install: async () => {},
  captureAgentTargets: async () => ({ format: 1, targets: [] }),
  isEffectiveUserRoot: () => false,
  resolveNewBinary: async () => '/new/aio-proxy',
  invokeAgentPostUpgrade: async () => [],
  isDaemonRunning: async () => false,
  isServiceManaged: () => true,
  restartService: async () => {},
  readInstalledVersion: async () => '2.0.0',
  ...overrides,
});

test('--check reports up-to-date without installing', async () => {
  const lines: string[] = [];
  await runUpgradeCommand({ check: true }, (l) => lines.push(l), makeDeps({ fetchLatest: async () => '1.0.0' }));
  expect(lines.join('\n')).toContain('1.0.0');
});

test('--check reports a newer version when available', async () => {
  const lines: string[] = [];
  await runUpgradeCommand({ check: true }, (l) => lines.push(l), makeDeps({ fetchLatest: async () => '2.0.0' }));
  expect(lines.join('\n')).toContain('2.0.0');
});

test('version-check failure throws and installs nothing', async () => {
  const lines: string[] = [];
  let installed = false;
  await expect(
    runUpgradeCommand(
      {},
      (l) => lines.push(l),
      makeDeps({
        resolveTarget: async () => {
          installed = true; // resolveTarget runs, but no install should follow a fetch failure
          return bunTarget;
        },
        fetchLatest: async () => {
          throw new Error('registry unreachable');
        },
        install: async () => {
          throw new Error('install should not run after a fetch failure');
        },
      }),
    ),
  ).rejects.toThrow();
  // no success/via line was printed -> no install dispatched
  expect(lines.some((l) => l.length > 0)).toBe(false);
  expect(installed).toBe(true);
});

test('resolveTarget failure surfaces the real reason as a CliExit', async () => {
  const err = await runUpgradeCommand(
    {},
    () => {},
    makeDeps({
      resolveTarget: async () => {
        throw new Error('cannot locate aio-proxy in PATH');
      },
      fetchLatest: async () => '2.0.0',
    }),
  ).catch((e) => e);
  expect(err).toBeInstanceOf(CliExit);
  expect((err as CliExit).code).toBe(EXIT.unrecoverable);
  expect((err as CliExit).message).toContain('cannot locate aio-proxy in PATH');
});

test('install failure is rethrown as a CliExit carrying the real reason', async () => {
  const lines: string[] = [];
  const err = await runUpgradeCommand(
    {},
    (l) => lines.push(l),
    makeDeps({
      resolveTarget: async () => ({ method: 'npm', command: '/usr/bin/npm', bin: '/usr/bin/aio-proxy' }),
      fetchLatest: async () => '2.0.0',
      install: async () => {
        throw new Error('npm exited with 1');
      },
    }),
  ).catch((e) => e);
  expect(err).toBeInstanceOf(CliExit);
  expect((err as CliExit).message).toContain('npm exited with 1');
  expect(lines.some((l) => l.includes('Upgraded to'))).toBe(false); // 未打印成功
});

const upgradeRun = (over: Partial<NonNullable<Deps>>) => {
  const lines: string[] = [];
  return {
    lines,
    done: runUpgradeCommand({}, (l) => lines.push(l), makeDeps({ fetchLatest: async () => '2.0.0', ...over })),
  };
};

test('managed service is restarted after a successful upgrade', async () => {
  let restarted = false;
  const { done } = upgradeRun({
    isDaemonRunning: async () => true,
    isServiceManaged: () => true,
    restartService: async () => {
      restarted = true;
    },
  });
  await done;
  // A managed daemon is designed to be bounced, so applying the upgrade restarts
  // it unconditionally — no opt-in flag.
  expect(restarted).toBe(true);
});

test('manually started daemon is not touched and gets a self-restart hint', async () => {
  let restarted = false;
  const { lines, done } = upgradeRun({
    isDaemonRunning: async () => true,
    isServiceManaged: () => false,
    restartService: async () => {
      restarted = true;
    },
  });
  await done;
  expect(restarted).toBe(false); // 手动启动无托管单元时，不调用 launchctl/systemctl
  expect(lines.join('\n')).toContain('manually'); // 给出自行重启提示
});

test('a stopped daemon needs no restart', async () => {
  let restarted = false;
  const { done } = upgradeRun({
    isDaemonRunning: async () => false,
    isServiceManaged: () => true,
    restartService: async () => {
      restarted = true;
    },
  });
  await done;
  expect(restarted).toBe(false);
});

test('successful install invokes the newly resolved binary with pre-install targets', async () => {
  const events: string[] = [];
  const deps = makeDeps({
    captureAgentTargets: async () => {
      events.push('capture');
      return PAYLOAD;
    },
    install: async () => {
      events.push('install');
    },
    resolveNewBinary: async (_target, version) => {
      events.push(`resolve:${version}`);
      return '/new/aio-proxy';
    },
    invokeAgentPostUpgrade: async (binary, payload) => {
      events.push(`post:${binary}`);
      expect(payload).toEqual(PAYLOAD);
      return [];
    },
  });
  await runUpgradeCommand({}, () => {}, deps);
  expect(events).toEqual(['capture', 'install', 'resolve:2.0.0', 'post:/new/aio-proxy']);
});

test('a failed Agent post-upgrade handshake prints a localized protocol warning', async () => {
  const { setLocale } = await import('@aio-proxy/i18n');
  await setLocale('zh-Hans');
  try {
    const lines: string[] = [];
    await runUpgradeCommand(
      {},
      (line) => lines.push(line),
      makeDeps({
        invokeAgentPostUpgrade: async () => {
          throw new Error('handshake failed');
        },
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('handshake failed');
    expect(text).not.toContain('aio-proxy upgraded, but Agent integrations could not be updated');
  } finally {
    await setLocale('en');
  }
});

test('adapter warning does not roll back a successful aio-proxy upgrade', async () => {
  const lines: string[] = [];
  await runUpgradeCommand(
    {},
    (line) => lines.push(line),
    makeDeps({
      invokeAgentPostUpgrade: async () => [{ target: 'omp', status: 'warning', reason: 'entry conflict' }],
    }),
  );
  expect(lines.join('\n')).toContain('aio-proxy agent configure omp');
});

test('a root effective user is warned and still updates only that effective users targets', async () => {
  const lines: string[] = [];
  const post = mock(async () => []);
  await runUpgradeCommand(
    {},
    (line) => lines.push(line),
    makeDeps({
      isEffectiveUserRoot: () => true,
      captureAgentTargets: async () => PAYLOAD,
      invokeAgentPostUpgrade: post,
    }),
  );
  expect(lines.join('\n')).toContain('root');
  expect(lines.join('\n')).toContain('aio-proxy agent configure <target>');
  expect(post).toHaveBeenCalledTimes(1);
});

test('--check never invokes post-upgrade', async () => {
  const post = mock(async () => []);
  await runUpgradeCommand({ check: true }, () => {}, makeDeps({ invokeAgentPostUpgrade: post }));
  expect(post).not.toHaveBeenCalled();
});

test('an up-to-date upgrade never invokes post-upgrade', async () => {
  const post = mock(async () => []);
  await runUpgradeCommand(
    {},
    () => {},
    makeDeps({
      fetchLatest: async () => '1.0.0',
      currentVersion: '1.0.0',
      invokeAgentPostUpgrade: post,
    }),
  );
  expect(post).not.toHaveBeenCalled();
});

test('managed service is restarted after post-upgrade finishes', async () => {
  const events: string[] = [];
  await runUpgradeCommand(
    {},
    () => {},
    makeDeps({
      invokeAgentPostUpgrade: async () => {
        events.push('post');
        return [];
      },
      isDaemonRunning: async () => true,
      isServiceManaged: () => true,
      restartService: async () => {
        events.push('restart');
      },
    }),
  );
  expect(events).toEqual(['post', 'restart']);
});

const writeExecutable = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

test('resolveUpgradeTargetFrom maps a Homebrew prefix symlink to Cellar as brew', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-brew-prefix-'));
  const cellar = join(prefix, 'Cellar', 'aio-proxy', '1.2.3', 'bin', 'aio-proxy');
  const bin = join(prefix, 'bin', 'aio-proxy');
  writeExecutable(join(prefix, 'bin', 'brew'), '#!/bin/sh\n');
  writeExecutable(cellar, '#!/bin/sh\n');
  symlinkSync(cellar, bin);
  expect(await resolveUpgradeTargetFrom(bin, {})).toEqual({
    method: 'brew',
    command: join(prefix, 'bin', 'brew'),
    bin,
  });
});

test('resolveUpgradeTargetFrom maps a Homebrew prefix symlink to brew even when npm sits beside it', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-brew-npm-cellar-'));
  const cellar = join(prefix, 'Cellar', 'aio-proxy', '1.2.3', 'bin', 'aio-proxy');
  const bin = join(prefix, 'bin', 'aio-proxy');
  writeExecutable(join(prefix, 'bin', 'brew'), '#!/bin/sh\n');
  writeExecutable(join(prefix, 'bin', 'npm'), '#!/bin/sh\n');
  writeExecutable(cellar, '#!/bin/sh\n');
  symlinkSync(cellar, bin);
  expect(await resolveUpgradeTargetFrom(bin, {})).toEqual({
    method: 'brew',
    command: join(prefix, 'bin', 'brew'),
    bin,
  });
});

test('resolveUpgradeTargetFrom maps a brew+npm sibling that is not a Cellar link to npm', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-brew-npm-sibling-'));
  const bin = join(prefix, 'bin', 'aio-proxy');
  writeExecutable(join(prefix, 'bin', 'brew'), '#!/bin/sh\n');
  writeExecutable(join(prefix, 'bin', 'npm'), '#!/bin/sh\n');
  writeExecutable(bin, '#!/bin/sh\n');
  expect(await resolveUpgradeTargetFrom(bin, {})).toEqual({
    method: 'npm',
    command: join(prefix, 'bin', 'npm'),
    bin,
  });
});

test('resolveUpgradeTargetFrom does not treat a brew sibling as Homebrew unless the path is Cellar', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-brew-sibling-only-'));
  const bin = join(prefix, 'bin', 'aio-proxy');
  writeExecutable(join(prefix, 'bin', 'brew'), '#!/bin/sh\n');
  writeExecutable(bin, '#!/bin/sh\n');
  await withEmptyManagerPath(async () => {
    expect(await resolveUpgradeTargetFrom(bin, {})).toEqual({ method: 'binary', path: bin });
  });
});

test('AIO_PROXY_UPGRADE_METHOD=brew still uses a sibling brew for a non-Cellar launcher', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-brew-env-'));
  const bin = join(prefix, 'bin', 'aio-proxy');
  writeExecutable(join(prefix, 'bin', 'brew'), '#!/bin/sh\n');
  writeExecutable(bin, '#!/bin/sh\n');
  expect(await resolveUpgradeTargetFrom(bin, { AIO_PROXY_UPGRADE_METHOD: 'brew' })).toEqual({
    method: 'brew',
    command: join(prefix, 'bin', 'brew'),
    bin,
  });
});

test('resolveUpgradeTargetFrom maps a Cellar path to brew, not binary, even when brew is off PATH', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-brew-cellar-'));
  const cellar = join(prefix, 'Cellar', 'aio-proxy', '1.2.3', 'bin', 'aio-proxy');
  writeExecutable(join(prefix, 'bin', 'brew'), '#!/bin/sh\n');
  writeExecutable(cellar, '#!/bin/sh\n');
  const previous = process.env['PATH'];
  process.env['PATH'] = '/usr/bin:/bin';
  try {
    expect(await resolveUpgradeTargetFrom(cellar, {})).toEqual({
      method: 'brew',
      command: join(prefix, 'bin', 'brew'),
      bin: join(prefix, 'bin', 'aio-proxy'),
    });
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
});

test('resolveUpgradeTargetFrom treats a standalone binary as binary', async () => {
  expect(await resolveUpgradeTargetFrom('/opt/aio-proxy', {})).toEqual({ method: 'binary', path: '/opt/aio-proxy' });
});

test('resolveUpgradeTargetFrom maps an npm prefix path to npm command and bin', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-npm-prefix-'));
  const bin = join(prefix, 'bin', 'aio-proxy');
  writeExecutable(join(prefix, 'bin', 'npm'), '#!/bin/sh\n');
  writeExecutable(bin, '#!/bin/sh\n');
  expect(await resolveUpgradeTargetFrom(bin, {})).toEqual({
    method: 'npm',
    command: join(prefix, 'bin', 'npm'),
    bin,
  });
});

const writePlatformCliBinary = (prefix: string, manager: 'npm' | 'bun' | 'pnpm'): string => {
  const native = join(
    prefix,
    'lib',
    'node_modules',
    'aio-proxy',
    'node_modules',
    '@aio-proxy',
    'cli-linux-x64',
    'bin',
    'aio-proxy',
  );
  writeExecutable(join(prefix, 'bin', manager), '#!/bin/sh\n');
  writeExecutable(join(prefix, 'bin', 'aio-proxy'), '#!/bin/sh\n');
  writeExecutable(native, '#!/bin/sh\n');
  return native;
};

const withEmptyManagerPath = async <T>(run: () => Promise<T>): Promise<T> => {
  const previous = process.env['PATH'];
  process.env['PATH'] = '/usr/bin:/bin';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
};

test('resolveUpgradeTargetFrom maps a node_modules/@aio-proxy/cli-linux-x64 binary to npm', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-npm-cli-pkg-'));
  const native = writePlatformCliBinary(prefix, 'npm');
  await withEmptyManagerPath(async () => {
    expect(await resolveUpgradeTargetFrom(native, {})).toEqual({
      method: 'npm',
      command: join(prefix, 'bin', 'npm'),
      bin: join(prefix, 'bin', 'aio-proxy'),
    });
  });
});

test('resolveUpgradeTargetFrom maps a bun global cli-* binary to bun, not binary', async () => {
  const bunHome = mkdtempSync(join(tmpdir(), 'aio-bun-home-'));
  const native = join(bunHome, 'install', 'global', 'node_modules', '@aio-proxy', 'cli-linux-x64', 'bin', 'aio-proxy');
  writeExecutable(join(bunHome, 'bin', 'bun'), '#!/bin/sh\n');
  writeExecutable(join(bunHome, 'bin', 'aio-proxy'), '#!/bin/sh\n');
  writeExecutable(native, '#!/bin/sh\n');
  await withEmptyManagerPath(async () => {
    expect(await resolveUpgradeTargetFrom(native, {})).toEqual({
      method: 'bun',
      command: join(bunHome, 'bin', 'bun'),
      bin: join(bunHome, 'bin', 'aio-proxy'),
    });
  });
});

test('resolveUpgradeTargetFrom maps a pnpm global cli-* binary to pnpm, not binary', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-pnpm-prefix-'));
  const native = join(prefix, 'global', '5', 'node_modules', '@aio-proxy', 'cli-linux-x64', 'bin', 'aio-proxy');
  writeExecutable(join(prefix, 'bin', 'pnpm'), '#!/bin/sh\n');
  writeExecutable(join(prefix, 'bin', 'aio-proxy'), '#!/bin/sh\n');
  writeExecutable(native, '#!/bin/sh\n');
  await withEmptyManagerPath(async () => {
    expect(await resolveUpgradeTargetFrom(native, {})).toEqual({
      method: 'pnpm',
      command: join(prefix, 'bin', 'pnpm'),
      bin: join(prefix, 'bin', 'aio-proxy'),
    });
  });
});

test('resolveManagedRestartExec uses the native cli-* binary for npm, not the JS shim', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-restart-npm-'));
  const native = writePlatformCliBinary(prefix, 'npm');
  expect(
    resolveManagedRestartExec({
      method: 'npm',
      command: join(prefix, 'bin', 'npm'),
      bin: join(prefix, 'bin', 'aio-proxy'),
    }),
  ).toBe(native);
});

test('resolveManagedRestartExec uses the native cli-* binary for pnpm, not the JS shim', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-restart-pnpm-'));
  const native = join(prefix, 'global', '5', 'node_modules', '@aio-proxy', 'cli-linux-x64', 'bin', 'aio-proxy');
  writeExecutable(join(prefix, 'bin', 'pnpm'), '#!/bin/sh\n');
  writeExecutable(join(prefix, 'bin', 'aio-proxy'), '#!/usr/bin/env node\n');
  writeExecutable(native, '#!/bin/sh\n');
  expect(
    resolveManagedRestartExec({
      method: 'pnpm',
      command: join(prefix, 'bin', 'pnpm'),
      bin: join(prefix, 'bin', 'aio-proxy'),
    }),
  ).toBe(native);
});

const writePnpmGlobalLayout = (options: {
  readonly prefix: string;
  readonly version: string;
  readonly globalNodeModules: string;
  readonly nestUnderAioProxy: boolean;
}): string => {
  const { prefix, version, globalNodeModules, nestUnderAioProxy } = options;
  const storeName = `@aio-proxy+cli-linux-x64@${version}`;
  const native = join(
    globalNodeModules,
    '.pnpm',
    storeName,
    'node_modules',
    '@aio-proxy',
    'cli-linux-x64',
    'bin',
    'aio-proxy',
  );
  const aioProxyReal = join(globalNodeModules, '.pnpm', `aio-proxy@${version}`, 'node_modules', 'aio-proxy');
  writeExecutable(native, '#!/bin/sh\n');
  mkdirSync(aioProxyReal, { recursive: true });
  writeFileSync(join(aioProxyReal, 'package.json'), JSON.stringify({ name: 'aio-proxy', version }));
  if (nestUnderAioProxy) {
    mkdirSync(join(aioProxyReal, 'node_modules', '@aio-proxy'), { recursive: true });
    symlinkSync(
      join(globalNodeModules, '.pnpm', storeName, 'node_modules', '@aio-proxy', 'cli-linux-x64'),
      join(aioProxyReal, 'node_modules', '@aio-proxy', 'cli-linux-x64'),
    );
  }
  mkdirSync(globalNodeModules, { recursive: true });
  const aioProxyLink = join(globalNodeModules, 'aio-proxy');
  try {
    unlinkSync(aioProxyLink);
  } catch {
    // first layout write has no existing link
  }
  symlinkSync(aioProxyReal, aioProxyLink);
  writeExecutable(join(prefix, 'bin', 'pnpm'), '#!/bin/sh\n');
  writeExecutable(join(prefix, 'bin', 'aio-proxy'), '#!/usr/bin/env node\n');
  return native;
};

test('resolveManagedRestartExec finds pnpm virtual-store cli-* under global/<n>/node_modules/.pnpm', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-restart-pnpm-virtual-'));
  const native = writePnpmGlobalLayout({
    prefix,
    version: '2.0.0',
    globalNodeModules: join(prefix, 'global', '5', 'node_modules'),
    nestUnderAioProxy: false,
  });
  expect(
    resolveManagedRestartExec({
      method: 'pnpm',
      command: join(prefix, 'bin', 'pnpm'),
      bin: join(prefix, 'bin', 'aio-proxy'),
    }),
  ).toBe(native);
});

test('resolveManagedRestartExec finds pnpm cli-* nested under the installed aio-proxy package', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-restart-pnpm-nested-'));
  const nodeModules = join(prefix, 'global', '5', 'node_modules');
  writePnpmGlobalLayout({
    prefix,
    version: '2.0.0',
    globalNodeModules: nodeModules,
    nestUnderAioProxy: true,
  });
  const nested = join(nodeModules, 'aio-proxy', 'node_modules', '@aio-proxy', 'cli-linux-x64', 'bin', 'aio-proxy');
  expect(
    resolveManagedRestartExec({
      method: 'pnpm',
      command: join(prefix, 'bin', 'pnpm'),
      bin: join(prefix, 'bin', 'aio-proxy'),
    }),
  ).toBe(nested);
});

test('resolveManagedRestartExec finds pnpm v11 isolated-install virtual-store cli-*', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-restart-pnpm-v11-'));
  const native = writePnpmGlobalLayout({
    prefix,
    version: '2.0.0',
    globalNodeModules: join(prefix, 'global', 'v11', 'abc123', 'node_modules'),
    nestUnderAioProxy: false,
  });
  expect(
    resolveManagedRestartExec({
      method: 'pnpm',
      command: join(prefix, 'bin', 'pnpm'),
      bin: join(prefix, 'bin', 'aio-proxy'),
    }),
  ).toBe(native);
});

test('resolveManagedRestartExec prefers the cli-* linked from the installed aio-proxy package', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-restart-pnpm-prefer-'));
  const nodeModules = join(prefix, 'global', '5', 'node_modules');
  const stale = writePnpmGlobalLayout({
    prefix,
    version: '1.0.0',
    globalNodeModules: nodeModules,
    nestUnderAioProxy: false,
  });
  writePnpmGlobalLayout({
    prefix,
    version: '2.0.0',
    globalNodeModules: nodeModules,
    nestUnderAioProxy: true,
  });
  const found = resolveManagedRestartExec({
    method: 'pnpm',
    command: join(prefix, 'bin', 'pnpm'),
    bin: join(prefix, 'bin', 'aio-proxy'),
  });
  expect(found).toBeDefined();
  expect(found).not.toBe(stale);
});

test('resolveManagedRestartExec uses the native cli-* binary for bun, not the JS shim', () => {
  const bunHome = mkdtempSync(join(tmpdir(), 'aio-restart-bun-'));
  const native = join(bunHome, 'install', 'global', 'node_modules', '@aio-proxy', 'cli-linux-x64', 'bin', 'aio-proxy');
  writeExecutable(join(bunHome, 'bin', 'bun'), '#!/bin/sh\n');
  writeExecutable(join(bunHome, 'bin', 'aio-proxy'), '#!/usr/bin/env node\n');
  writeExecutable(native, '#!/bin/sh\n');
  expect(
    resolveManagedRestartExec({
      method: 'bun',
      command: join(bunHome, 'bin', 'bun'),
      bin: join(bunHome, 'bin', 'aio-proxy'),
    }),
  ).toBe(native);
});

test('resolveManagedRestartExec returns undefined when no native binary exists so restart falls back', () => {
  expect(
    resolveManagedRestartExec({
      method: 'npm',
      command: '/usr/bin/npm',
      bin: '/usr/bin/aio-proxy',
    }),
  ).toBeUndefined();
});

test('resolveManagedRestartExec returns the brew launcher bin', () => {
  expect(
    resolveManagedRestartExec({
      method: 'brew',
      command: '/opt/homebrew/bin/brew',
      bin: '/opt/homebrew/bin/aio-proxy',
    }),
  ).toBe('/opt/homebrew/bin/aio-proxy');
});

test('AIO_PROXY_UPGRADE_METHOD=npm reconstructs an absolute command from the cli-* prefix', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-npm-env-'));
  const native = writePlatformCliBinary(prefix, 'npm');
  await withEmptyManagerPath(async () => {
    const target = await resolveUpgradeTargetFrom(native, { AIO_PROXY_UPGRADE_METHOD: 'npm' });
    expect(target).toEqual({
      method: 'npm',
      command: join(prefix, 'bin', 'npm'),
      bin: join(prefix, 'bin', 'aio-proxy'),
    });
    expect(target.method === 'npm' && target.command).not.toBe('npm');
  });
});

test('runPackageManagerUpgrade for brew execs the absolute command, never the string brew', async () => {
  const calls: string[][] = [];
  const original = Bun.spawn;
  Bun.spawn = ((cmd: string[]) => {
    calls.push(cmd);
    return { exited: Promise.resolve(0) };
  }) as typeof Bun.spawn;
  try {
    await runPackageManagerUpgrade(
      { method: 'brew', command: '/opt/homebrew/bin/brew', bin: '/opt/homebrew/bin/aio-proxy' },
      '1.2.3',
      { registry: NPM_REGISTRY, force: false },
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((cmd) => cmd[0] !== 'brew')).toBe(true);
    expect(calls.some((cmd) => cmd[0] === '/opt/homebrew/bin/brew')).toBe(true);
  } finally {
    Bun.spawn = original;
  }
});

test('runPackageManagerUpgrade for npm sets PATH so the sibling node satisfies env node', async () => {
  const calls: { readonly cmd: string[]; readonly path?: string }[] = [];
  const original = Bun.spawn;
  Bun.spawn = ((cmd: string[], options?: { readonly env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, path: options?.env?.['PATH'] });
    return { exited: Promise.resolve(0) };
  }) as typeof Bun.spawn;
  try {
    await runPackageManagerUpgrade(
      { method: 'npm', command: '/usr/local/bin/npm', bin: '/usr/local/bin/aio-proxy' },
      '1.2.3',
      { registry: NPM_REGISTRY, force: false },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd[0]).toBe('/usr/local/bin/npm');
    expect(calls[0]?.path).toContain('/usr/local/bin');
    expect(calls[0]?.path).toContain('/usr/bin');
    expect(calls[0]?.path).toContain('/bin');
  } finally {
    Bun.spawn = original;
  }
});

test('runUpgradeCommand pins options.version and does not call fetchLatest', async () => {
  const fetchLatest = mock(async () => '1.2.5');
  let installed: string | undefined;
  const result = await runUpgradeCommand(
    { version: '1.2.4' },
    () => {},
    makeDeps({
      currentVersion: '1.2.3',
      fetchLatest,
      install: async (_target, version) => {
        installed = version;
      },
    }),
  );
  expect(fetchLatest).not.toHaveBeenCalled();
  expect(installed).toBe('1.2.4');
  expect(result).toBe('installed');
});

test('runUpgradeCommand with the current version returns unchanged and does not install', async () => {
  let installed = false;
  const result = await runUpgradeCommand(
    { version: '1.0.0' },
    () => {},
    makeDeps({
      currentVersion: '1.0.0',
      install: async () => {
        installed = true;
      },
    }),
  );
  expect(result).toBe('unchanged');
  expect(installed).toBe(false);
});

test('brew --force on the current version still installs and restarts', async () => {
  let installed = false;
  let restarted: string | undefined;
  const result = await runUpgradeCommand(
    { version: '1.0.0', force: true },
    () => {},
    makeDeps({
      currentVersion: '1.0.0',
      resolveTarget: async () => ({
        method: 'brew',
        command: '/opt/homebrew/bin/brew',
        bin: '/opt/homebrew/bin/aio-proxy',
      }),
      readInstalledVersion: async () => '1.0.0',
      isDaemonRunning: async () => true,
      isServiceManaged: () => true,
      install: async () => {
        installed = true;
      },
      restartService: async (exec) => {
        restarted = exec;
      },
    }),
  );
  expect(result).toBe('installed');
  expect(installed).toBe(true);
  expect(restarted).toBe('/opt/homebrew/bin/aio-proxy');
});

test('brew install whose launcher version stays at current returns unchanged and skips restart', async () => {
  let restarted = false;
  const result = await runUpgradeCommand(
    { version: '2.0.0' },
    () => {},
    makeDeps({
      currentVersion: '1.0.0',
      resolveTarget: async () => ({
        method: 'brew',
        command: '/opt/homebrew/bin/brew',
        bin: '/opt/homebrew/bin/aio-proxy',
      }),
      readInstalledVersion: async () => '1.0.0',
      isDaemonRunning: async () => true,
      isServiceManaged: () => true,
      restartService: async () => {
        restarted = true;
      },
    }),
  );
  expect(result).toBe('unchanged');
  expect(restarted).toBe(false);
});

test('runUpgradeCommand restarts npm installs with the native cli-* path, not the JS shim', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'aio-npm-restart-'));
  const native = writePlatformCliBinary(prefix, 'npm');
  const shim = join(prefix, 'bin', 'aio-proxy');
  let restarted: string | undefined = 'unset';
  const result = await runUpgradeCommand(
    { version: '2.0.0' },
    () => {},
    makeDeps({
      currentVersion: '1.0.0',
      resolveTarget: async () => ({
        method: 'npm',
        command: join(prefix, 'bin', 'npm'),
        bin: shim,
      }),
      isDaemonRunning: async () => true,
      isServiceManaged: () => true,
      restartService: async (exec) => {
        restarted = exec;
      },
    }),
  );
  expect(result).toBe('installed');
  expect(restarted).toBe(native);
  expect(restarted).not.toBe(shim);
});

test('successful brew upgrade restarts with the stable launcher', async () => {
  let restarted: string | undefined;
  const result = await runUpgradeCommand(
    { version: '2.0.0' },
    () => {},
    makeDeps({
      currentVersion: '1.0.0',
      resolveTarget: async () => ({
        method: 'brew',
        command: '/opt/homebrew/bin/brew',
        bin: '/opt/homebrew/bin/aio-proxy',
      }),
      readInstalledVersion: async () => '2.0.0',
      isDaemonRunning: async () => true,
      isServiceManaged: () => true,
      restartService: async (exec) => {
        restarted = exec;
      },
    }),
  );
  expect(result).toBe('installed');
  expect(restarted).toBe('/opt/homebrew/bin/aio-proxy');
});

test('resolveNewAgentBinary for a brew target uses target.bin, not Bun.which', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-brew-agent-bin-'));
  const binary = join(root, 'aio-proxy');
  writeExecutable(
    binary,
    `#!/usr/bin/env bun
if (process.argv[2] === "--version") { console.log("2.0.0"); process.exit(0); }
process.exit(9);
`,
  );
  await expect(
    resolveNewAgentBinary({ method: 'brew', command: '/opt/homebrew/bin/brew', bin: binary }, '2.0.0'),
  ).resolves.toBe(binary);
});
