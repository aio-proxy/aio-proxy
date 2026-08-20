import { expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isPathInDirectory, resolveUpgradeMethod } from './detect';

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
import { buildBunInstallArgs, buildHomebrewUpdateArgs, buildNpmInstallArgs, buildPnpmInstallArgs } from './methods';

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
import type { AgentPostUpgradePayload } from './post-upgrade-agents';
import { runUpgradeCommand } from './upgrade';

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

type UpgradeDeps = NonNullable<Parameters<typeof runUpgradeCommand>[2]>;
const makeDeps = (overrides: Partial<UpgradeDeps> = {}): UpgradeDeps => ({
  resolveTarget: async () => ({ method: 'bun' }),
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
          return { method: 'bun' };
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
      resolveTarget: async () => ({ method: 'npm' }),
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
