import { expect, mock, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliExit } from '../exit';
import { resolveStableManagedExec } from '../upgrade/detect';
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  launchdDomain,
  launchdJobTarget,
  readDesktopOwnedUnit,
  resolveExec,
  serviceRestart,
  serviceStart,
  writeManagedUnit,
} from './service';
import { LAUNCHD_EXEC_WRAPPER } from './unit-templates';

// A stand-in for launchd: `print` reports the job loaded after bootstrap or kickstart and unloaded
// after bootout. `bootstrapLoads: false` models launchctl exiting 0 while launchd never took the job.
// `teardownPolls` models bootout returning early ("36: Operation now in progress"): print keeps
// finding the job for that many more calls (Infinity: it never goes away).
const fakeLaunchd = (
  loaded: boolean,
  options: { readonly bootstrapLoads?: boolean; readonly teardownPolls?: number } = {},
) => {
  const calls: string[] = [];
  let held = loaded;
  let teardown = 0;
  return {
    calls,
    runManager: async (cmd: readonly string[]) => {
      calls.push(cmd.join(' '));
      if (cmd[1] === 'bootout') {
        teardown = options.teardownPolls ?? 0;
        if (teardown === 0) held = false;
      }
      if (cmd[1] === 'bootstrap' && options.bootstrapLoads !== false) held = true;
      return 0;
    },
    printJob: async () => {
      if (held && teardown > 0) {
        teardown -= 1;
        if (teardown === 0) held = false;
        return 0;
      }
      return held ? 0 : 113;
    },
  };
};

for (const platform of ['linux', 'darwin'] as const) {
  for (const command of [serviceStart, serviceRestart]) {
    test(`${command.name} on ${platform} installs a missing user service before starting it`, async () => {
      const launchd = fakeLaunchd(false);
      const writeManagedUnit = mock(async () => '/tmp/unused');
      await command({
        platform,
        unitInstalled: () => false,
        install: async (options) => {
          expect(options?.system).not.toBe(true);
          launchd.calls.push('install');
        },
        runManager: launchd.runManager,
        printJob: launchd.printJob,
        unitPath: '/tmp/service.plist',
        writeManagedUnit,
      });
      expect(launchd.calls).toEqual(
        platform === 'linux'
          ? ['install', 'systemctl --user start aio-proxy.service']
          : [
              'install',
              `launchctl enable ${launchdJobTarget()}`,
              `launchctl bootstrap ${launchdDomain()} /tmp/service.plist`,
            ],
      );
      expect(writeManagedUnit).not.toHaveBeenCalled();
    });

    for (const failingStep of ['install', 'start'] as const) {
      test(`${command.name} on ${platform} shows recovery instructions only after automatic ${failingStep} fails`, async () => {
        const failure = new CliExit(2, 'Permission denied');
        const install = mock(async () => {
          if (failingStep === 'install') throw failure;
        });
        const runManager = mock(async (): Promise<number> => {
          throw failure;
        });
        const error = await command({ platform, unitInstalled: () => false, install, runManager }).catch(
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(CliExit);
        if (!(error instanceof CliExit)) throw new Error('Expected a service setup error');
        expect(error.code).toBe(2);
        expect(error.message).toContain('Permission denied');
        expect(error.message).toContain('aio-proxy service install --user');
        expect(error.message).toContain('aio-proxy service start');
        expect(install).toHaveBeenCalledTimes(1);
        expect(runManager).toHaveBeenCalledTimes(failingStep === 'install' ? 0 : 1);
      });
    }
  }
}

test('serviceStart on linux starts an installed service through its manager', async () => {
  const runManager = mock(async () => 0);
  const install = mock(async () => {});
  await serviceStart({ platform: 'linux', unitInstalled: () => true, runManager, install });
  expect(install).not.toHaveBeenCalled();
  expect(runManager).toHaveBeenCalledWith(['systemctl', '--user', 'start', 'aio-proxy.service']);
});

test('serviceStart bootstraps an unloaded launchd job after clearing the override a stop leaves', async () => {
  const launchd = fakeLaunchd(false);
  await serviceStart({ platform: 'darwin', unitInstalled: () => true, unitPath: '/tmp/service.plist', ...launchd });
  expect(launchd.calls).toEqual([
    `launchctl enable ${launchdJobTarget()}`,
    `launchctl bootstrap ${launchdDomain()} /tmp/service.plist`,
  ]);
});

test('serviceStart kickstarts a loaded launchd job instead of re-loading it', async () => {
  const launchd = fakeLaunchd(true);
  await serviceStart({ platform: 'darwin', unitInstalled: () => true, unitPath: '/tmp/service.plist', ...launchd });
  expect(launchd.calls).toEqual([
    `launchctl enable ${launchdJobTarget()}`,
    `launchctl kickstart ${launchdJobTarget()}`,
  ]);
});

test('serviceStart fails when launchd does not hold the job although every launchctl call exited 0', async () => {
  const launchd = fakeLaunchd(false, { bootstrapLoads: false });
  const error = await serviceStart({
    platform: 'darwin',
    unitInstalled: () => true,
    unitPath: '/tmp/service.plist',
    ...launchd,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliExit);
  expect((error as CliExit).message).toContain(`launchctl print ${launchdJobTarget()}`);
});

test('systemd unit runs `run`, restarts on failure, skips exit 1', () => {
  const unit = renderSystemdUnit({ exec: '/usr/local/bin/aio-proxy', configPath: '/home/u/.aio-proxy/config.jsonc' });
  expect(unit).toContain('ExecStart="/usr/local/bin/aio-proxy" run');
  expect(unit).toContain('Restart=on-failure');
  expect(unit).toContain('RestartPreventExitStatus=1');
  expect(unit).toContain('AIO_PROXY_MANAGED=1');
  // The daemon loads service.env itself (data-only, no shell), so the unit no
  // longer delegates env loading to systemd's EnvironmentFile.
  expect(unit).not.toContain('EnvironmentFile');
});

test('launchd plist runs `run` via a wrapper that remaps exit 1 to a clean exit', () => {
  const plist = renderLaunchdPlist({
    exec: '/usr/local/bin/aio-proxy',
    configPath: '/Users/u/.aio-proxy/config.jsonc',
  });
  // launchd has no RestartPreventExitStatus, so ProgramArguments wraps the exec
  // in /bin/sh and passes it as $0; the wrapper runs `<exec> run`.
  expect(plist).toContain('<string>/bin/sh</string>');
  expect(plist).toContain('<string>/usr/local/bin/aio-proxy</string>');
  expect(plist).toContain('AIO_PROXY_MANAGED');
  expect(plist).toContain('<string>1</string>');
  expect(plist).toContain('"$0" run');
  // SuccessfulExit=false relaunches on any non-zero exit, so the wrapper must
  // remap exit 1 (unrecoverable) to 0 to prevent a bad-config restart loop.
  expect(plist).toContain('SuccessfulExit');
  expect(plist).toContain('if [ "$status" -eq 1 ]; then exit 0; fi');
  // The daemon loads service.env itself, so the wrapper must NOT source any env
  // file — no shell ever touches provider secrets (avoids $/backtick expansion).
  expect(plist).not.toContain('. "$1"');
  expect(plist).not.toContain('service.env');
});

test('launchd plist serializes a valid launchd document', () => {
  const document = Bun.XML.parse(
    renderLaunchdPlist({
      exec: '/usr/local/bin/aio-proxy',
      configPath: '/Users/u/.aio-proxy/config.jsonc',
    }),
    { compact: false },
  );
  const elements = (children: Bun.XML.Node['children']): Bun.XML.Node[] =>
    children.filter((child): child is Bun.XML.Node => typeof child !== 'string');
  const text = (node: Bun.XML.Node): string => {
    const [value] = node.children;
    if (typeof value !== 'string') throw new Error(`Expected text in <${node.name}>`);
    return value;
  };

  expect(document.name).toBe('plist');
  expect(document.attributes).toEqual({ version: '1.0' });
  const [dict] = elements(document.children);
  if (dict === undefined) throw new Error('Expected plist dict');
  expect(elements(dict.children).map((node) => node.name)).toEqual([
    'key',
    'string',
    'key',
    'array',
    'key',
    'dict',
    'key',
    'dict',
    'key',
    'true',
  ]);
  const topLevel = elements(dict.children);
  const at = (index: number): Bun.XML.Node => {
    const node = topLevel[index];
    if (node === undefined) throw new Error(`Expected plist node at index ${index}`);
    return node;
  };
  expect(text(at(0))).toBe('Label');
  expect(text(at(1))).toBe('com.aio-proxy.agent');
  expect(text(at(2))).toBe('ProgramArguments');
  expect(elements(at(3).children).map(text)).toEqual([
    '/bin/sh',
    '-c',
    LAUNCHD_EXEC_WRAPPER,
    '/usr/local/bin/aio-proxy',
  ]);
  expect(text(at(4))).toBe('EnvironmentVariables');
  expect(
    elements(at(5).children).map((node) => (node.name === 'key' || node.name === 'string' ? text(node) : node.name)),
  ).toEqual(['AIO_PROXY_HOME', '/Users/u/.aio-proxy', 'AIO_PROXY_MANAGED', '1']);
  expect(text(at(6))).toBe('KeepAlive');
  expect(elements(at(7).children).map((node) => (node.name === 'key' ? text(node) : node.name))).toEqual([
    'SuccessfulExit',
    'false',
  ]);
  expect(text(at(8))).toBe('RunAtLoad');
});

test('systemd unit quotes an ExecStart path containing spaces', () => {
  // Unquoted, systemd would split `/home/a user/bin/aio-proxy` and try to run
  // `/home/a`, so the daemon never starts. The value must be double-quoted.
  const unit = renderSystemdUnit({
    exec: '/home/a user/bin/aio-proxy',
    configPath: '/home/a user/.aio-proxy/config.jsonc',
  });
  expect(unit).toContain('ExecStart="/home/a user/bin/aio-proxy" run');
  expect(unit).toContain('Environment="AIO_PROXY_HOME=/home/a user/.aio-proxy"');
  expect(unit).toContain('Environment="AIO_PROXY_MANAGED=1"');
});

test('launchd plist XML-escapes an ampersand in the exec path', () => {
  // A raw `&` produces an invalid plist that the LaunchAgent cannot load; it
  // must be escaped to `&amp;` in every dynamic string.
  const plist = renderLaunchdPlist({
    exec: '/home/a&b/bin/aio-proxy',
    configPath: '/Users/a&b/.aio-proxy/config.jsonc',
  });
  expect(plist).toContain('<string>/home/a&amp;b/bin/aio-proxy</string>');
  expect(plist).toContain('<string>/Users/a&amp;b/.aio-proxy</string>');
  expect(plist).not.toContain('a&b/bin/aio-proxy');
});

test('managed service units retain executable search paths for local Agents', () => {
  const path = '/Users/a&b/.local/bin:/Users/a&b/.npm-global/bin:/usr/bin';
  const options = { exec: '/usr/local/bin/aio-proxy', configPath: '/Users/a&b/.aio-proxy/config.jsonc', path };
  const plist = renderLaunchdPlist(options);
  const unit = renderSystemdUnit(options);
  expect(plist).toContain('<key>PATH</key>');
  expect(plist).toContain('<string>/Users/a&amp;b/.local/bin:/Users/a&amp;b/.npm-global/bin:/usr/bin</string>');
  expect(unit).toContain('Environment="PATH=/Users/a&b/.local/bin:/Users/a&b/.npm-global/bin:/usr/bin"');
});

test('resolveExec prefers the stable PATH launcher over its versioned symlink target', () => {
  // Regression: brew exposes /opt/homebrew/bin/aio-proxy -> Cellar/<ver>/bin/aio-proxy.
  // execPath resolves to the versioned target, but baking that breaks after
  // `brew upgrade` deletes the old Cellar dir. When the PATH launcher resolves to
  // the same binary we're running as, bake the stable launcher so ExecStart
  // survives upgrades (brew retargets the symlink).
  const versioned = '/opt/homebrew/Cellar/aio-proxy/0.3.0/bin/aio-proxy';
  const launcher = '/opt/homebrew/bin/aio-proxy';
  const realpath = (p: string) => (p === launcher ? versioned : p);
  expect(resolveExec(() => launcher, versioned, realpath)).toBe(launcher);
});

test('resolveExec targets execPath when no PATH launcher resolves to it', () => {
  // A managed run has a minimal PATH without node, so the ExecStart target must be
  // the self-contained native binary. With no matching launcher on PATH, use
  // process.execPath directly (npm invokes us AS the native binary).
  const execPath = '/opt/homebrew/bin/aio-proxy';
  expect(
    resolveExec(
      () => null,
      execPath,
      (p) => p,
      () => true,
    ),
  ).toBe(execPath);
});

test('resolveExec defers to the PATH launcher when execPath was deleted mid-upgrade', () => {
  // Regression: an in-process `aio-proxy upgrade` on brew deletes the running
  // Cellar execPath while retargeting the launcher symlink to the new binary.
  // resolveExec runs in the old process, so execPath no longer exists; it must
  // bake the live launcher, not the deleted path. realpath(execPath) throws
  // (gone), so sameBinary is false and the exists guard rejects execPath.
  const deletedExec = '/opt/homebrew/Cellar/aio-proxy/0.2.1/bin/aio-proxy';
  const launcher = '/opt/homebrew/bin/aio-proxy';
  const realpath = (p: string) => {
    if (p === deletedExec) throw new Error('ENOENT');
    return p;
  };
  expect(
    resolveExec(
      () => launcher,
      deletedExec,
      realpath,
      (p) => p !== deletedExec,
    ),
  ).toBe(launcher);
});

test('resolveExec falls back to PATH when execPath is not the native binary', () => {
  // e.g. dev `bun run`: execPath is the bun interpreter, so resolve via PATH.
  const launcher = '/usr/local/bin/aio-proxy';
  expect(
    resolveExec(
      () => launcher,
      '/opt/homebrew/bin/bun',
      (p) => p,
      () => true,
    ),
  ).toBe(launcher);
});

test('resolveExec fails fast when the native binary is not found', () => {
  // Falling back to the interpreter path would render `ExecStart=<bun> run`, an
  // invalid unit that never starts; installing must refuse instead.
  let caught: unknown;
  try {
    resolveExec(
      () => null,
      '/opt/homebrew/bin/bun',
      (p) => p,
      () => true,
    );
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CliExit);
  expect((caught as CliExit).code).toBe(1);
});

// writeManagedUnit takes an explicit target path (test seam) so these run on any
// host without touching the real ~/Library/LaunchAgents.
test('writeManagedUnit rewrites a stale plist with the fresh exec path', async () => {
  // Regression for the brew-upgrade failure: an existing unit points at a deleted
  // versioned binary (old Cellar path). Restart must regenerate the unit, not just
  // stop/start it, so the stale ExecStart is replaced with the current launcher.
  const dir = join(tmpdir(), `aio-svc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const plistPath = join(dir, 'com.aio-proxy.agent.plist');
  const stale = '/opt/homebrew/Cellar/aio-proxy/0.2.1/bin/aio-proxy';
  writeFileSync(plistPath, renderLaunchdPlist({ exec: stale, configPath: join(dir, 'config.jsonc') }));
  expect(readFileSync(plistPath, 'utf8')).toContain(stale);

  const fresh = '/opt/homebrew/bin/aio-proxy';
  const written = await writeManagedUnit('darwin', fresh, plistPath);

  expect(written).toBe(plistPath);
  const contents = readFileSync(plistPath, 'utf8');
  expect(contents).toContain(`<string>${fresh}</string>`);
  expect(contents).not.toContain(stale);
});

test('writeManagedUnit creates the unit and parent dir when none exists', async () => {
  const plistPath = join(
    tmpdir(),
    `aio-svc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'LaunchAgents',
    'com.aio-proxy.agent.plist',
  );
  expect(existsSync(plistPath)).toBe(false);
  await writeManagedUnit('darwin', '/opt/homebrew/bin/aio-proxy', plistPath);
  expect(existsSync(plistPath)).toBe(true);
});

test('rewriting an older launchd unit restores user Agent directories from a minimal PATH', async () => {
  const plistPath = join(tmpdir(), `aio-svc-agent-path-${crypto.randomUUID()}`, 'com.aio-proxy.agent.plist');
  const previous = process.env['PATH'];
  process.env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    await writeManagedUnit('darwin', '/opt/homebrew/bin/aio-proxy', plistPath);
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
  const contents = readFileSync(plistPath, 'utf8');
  expect(contents).toContain(`<string>/usr/bin:/bin:/usr/sbin:/sbin:${join(homedir(), '.opencode/bin')}`);
  expect(contents).toContain(join(homedir(), '.local/bin'));
  expect(contents).toContain(join(homedir(), '.npm-global/bin'));
});

test('resolveStableManagedExec maps a Cellar path to the stable Homebrew launcher', () => {
  expect(resolveStableManagedExec('/opt/homebrew/Cellar/aio-proxy/0.3.0/bin/aio-proxy')).toBe(
    '/opt/homebrew/bin/aio-proxy',
  );
  expect(resolveStableManagedExec('/home/linuxbrew/.linuxbrew/Cellar/aio-proxy/1.10.0/bin/aio-proxy')).toBe(
    '/home/linuxbrew/.linuxbrew/bin/aio-proxy',
  );
});

test('resolveExec maps a Cellar execPath to the stable Homebrew launcher when PATH is empty', () => {
  const versioned = '/opt/homebrew/Cellar/aio-proxy/0.3.0/bin/aio-proxy';
  expect(
    resolveExec(
      () => null,
      versioned,
      (p) => p,
      () => true,
    ),
  ).toBe('/opt/homebrew/bin/aio-proxy');
});

test('writeManagedUnit persists npm when ExecStart is the native cli-* binary and PATH has the shim', async () => {
  const prefix = join(tmpdir(), `aio-npm-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  const shim = join(prefix, 'bin', 'aio-proxy');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  mkdirSync(join(native, '..'), { recursive: true });
  writeFileSync(join(prefix, 'bin', 'npm'), '#!/bin/sh\n');
  writeFileSync(shim, '#!/bin/sh\n');
  writeFileSync(native, '#!/bin/sh\n');
  chmodSync(join(prefix, 'bin', 'npm'), 0o755);
  chmodSync(shim, 0o755);
  chmodSync(native, 0o755);

  const plistPath = join(prefix, 'LaunchAgents', 'com.aio-proxy.agent.plist');
  const previous = process.env['PATH'];
  process.env['PATH'] = `${join(prefix, 'bin')}:/usr/bin:/bin`;
  try {
    await writeManagedUnit('darwin', native, plistPath);
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }

  const contents = readFileSync(plistPath, 'utf8');
  expect(contents).toContain('<key>AIO_PROXY_UPGRADE_METHOD</key>');
  expect(contents).toContain('<string>npm</string>');
  expect(contents).toContain(`<string>${native}</string>`);
  expect(contents).not.toContain(`<string>${shim}</string>`);
});

test('writeManagedUnit does not persist bun for a standalone binary in .bun/bin next to a leftover package', async () => {
  const bunHome = join(tmpdir(), `aio-leftover-bun-${Date.now()}-${Math.random().toString(36).slice(2)}`, '.bun');
  const bin = join(bunHome, 'bin', 'aio-proxy');
  mkdirSync(join(bunHome, 'bin'), { recursive: true });
  mkdirSync(join(bunHome, 'install', 'global', 'node_modules', 'aio-proxy'), { recursive: true });
  writeFileSync(join(bunHome, 'bin', 'bun'), '#!/bin/sh\n');
  writeFileSync(bin, '#!/bin/sh\n');
  writeFileSync(
    join(bunHome, 'install', 'global', 'node_modules', 'aio-proxy', 'package.json'),
    '{"name":"aio-proxy"}\n',
  );
  chmodSync(join(bunHome, 'bin', 'bun'), 0o755);
  chmodSync(bin, 0o755);

  const plistPath = join(bunHome, 'LaunchAgents', 'com.aio-proxy.agent.plist');
  const previous = process.env['PATH'];
  process.env['PATH'] = `${join(bunHome, 'bin')}:/usr/bin:/bin`;
  try {
    await writeManagedUnit('darwin', bin, plistPath);
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }

  const contents = readFileSync(plistPath, 'utf8');
  expect(contents).toContain(`<string>${bin}</string>`);
  expect(contents).not.toContain('AIO_PROXY_UPGRADE_METHOD');
});

test('writeManagedUnit does not persist npm for a standalone binary next to a leftover npm package dir', async () => {
  const prefix = join(tmpdir(), `aio-leftover-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const bin = join(prefix, 'bin', 'aio-proxy');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  mkdirSync(join(prefix, 'lib', 'node_modules', 'aio-proxy'), { recursive: true });
  writeFileSync(join(prefix, 'bin', 'npm'), '#!/bin/sh\n');
  writeFileSync(bin, '#!/bin/sh\n');
  writeFileSync(join(prefix, 'lib', 'node_modules', 'aio-proxy', 'package.json'), '{"name":"aio-proxy"}\n');
  chmodSync(join(prefix, 'bin', 'npm'), 0o755);
  chmodSync(bin, 0o755);

  const plistPath = join(prefix, 'LaunchAgents', 'com.aio-proxy.agent.plist');
  const previous = process.env['PATH'];
  process.env['PATH'] = `${join(prefix, 'bin')}:/usr/bin:/bin`;
  try {
    await writeManagedUnit('darwin', bin, plistPath);
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }

  const contents = readFileSync(plistPath, 'utf8');
  expect(contents).toContain(`<string>${bin}</string>`);
  expect(contents).not.toContain('AIO_PROXY_UPGRADE_METHOD');
});

test('writeManagedUnit does not persist npm for a standalone binary that only sits next to npm', async () => {
  const prefix = join(tmpdir(), `aio-curl-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const bin = join(prefix, 'bin', 'aio-proxy');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeFileSync(join(prefix, 'bin', 'npm'), '#!/bin/sh\n');
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(join(prefix, 'bin', 'npm'), 0o755);
  chmodSync(bin, 0o755);

  const plistPath = join(prefix, 'LaunchAgents', 'com.aio-proxy.agent.plist');
  const previous = process.env['PATH'];
  process.env['PATH'] = `${join(prefix, 'bin')}:/usr/bin:/bin`;
  try {
    await writeManagedUnit('darwin', bin, plistPath);
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }

  const contents = readFileSync(plistPath, 'utf8');
  expect(contents).toContain(`<string>${bin}</string>`);
  expect(contents).not.toContain('AIO_PROXY_UPGRADE_METHOD');
});

test('writeManagedUnit persists npm from the PATH shim when the native cli-* prefix has no manager', async () => {
  const nativeRoot = join(tmpdir(), `aio-native-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const pathRoot = join(tmpdir(), `aio-path-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const native = join(nativeRoot, 'node_modules', '@aio-proxy', 'cli-linux-x64', 'bin', 'aio-proxy');
  const shim = join(pathRoot, 'bin', 'aio-proxy');
  mkdirSync(join(native, '..'), { recursive: true });
  mkdirSync(join(pathRoot, 'bin'), { recursive: true });
  writeFileSync(native, '#!/bin/sh\n');
  writeFileSync(shim, '#!/bin/sh\n');
  writeFileSync(join(pathRoot, 'bin', 'npm'), '#!/bin/sh\n');
  chmodSync(native, 0o755);
  chmodSync(shim, 0o755);
  chmodSync(join(pathRoot, 'bin', 'npm'), 0o755);

  const plistPath = join(pathRoot, 'LaunchAgents', 'com.aio-proxy.agent.plist');
  const previous = process.env['PATH'];
  process.env['PATH'] = `${join(pathRoot, 'bin')}:/usr/bin:/bin`;
  try {
    await writeManagedUnit('darwin', native, plistPath);
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }

  const contents = readFileSync(plistPath, 'utf8');
  expect(contents).toContain('<key>AIO_PROXY_UPGRADE_METHOD</key>');
  expect(contents).toContain('<string>npm</string>');
  expect(contents).toContain(`<string>${native}</string>`);
});

test('systemd and launchd templates persist AIO_PROXY_UPGRADE_METHOD when known', () => {
  const unit = renderSystemdUnit({
    exec: '/opt/homebrew/bin/aio-proxy',
    configPath: '/home/u/.aio-proxy/config.jsonc',
    upgradeMethod: 'brew',
  });
  expect(unit).toContain('Environment="AIO_PROXY_UPGRADE_METHOD=brew"');
  const plist = renderLaunchdPlist({
    exec: '/opt/homebrew/bin/aio-proxy',
    configPath: '/Users/u/.aio-proxy/config.jsonc',
    upgradeMethod: 'npm',
  });
  expect(plist).toContain('<key>AIO_PROXY_UPGRADE_METHOD</key>');
  expect(plist).toContain('<string>npm</string>');
});

test('serviceRestart rewrites the unit with the provided exec', async () => {
  const written: { readonly os: string; readonly exec?: string }[] = [];
  await serviceRestart({
    platform: 'linux',
    unitInstalled: () => true,
    exec: '/opt/homebrew/bin/aio-proxy',
    writeManagedUnit: async (os, exec) => {
      written.push({ os, exec });
      return '/tmp/aio-proxy.service';
    },
    runManager: async () => 0,
  });
  expect(written).toEqual([{ os: 'linux', exec: '/opt/homebrew/bin/aio-proxy' }]);
});

test('Darwin in-job serviceRestart spawns a detached helper that unloads without waiting for this PID', async () => {
  const spawned: { readonly cmd: string[]; readonly detached?: boolean }[] = [];
  const manager: string[][] = [];
  await serviceRestart({
    platform: 'darwin',
    env: { XPC_SERVICE_NAME: 'com.aio-proxy.agent' },
    isTTY: false,
    unitInstalled: () => true,
    unitPath: '/tmp/com.aio-proxy.agent.plist',
    writeManagedUnit: async () => '/tmp/com.aio-proxy.agent.plist',
    spawn: ((cmd: string[], options?: { readonly detached?: boolean }) => {
      spawned.push({ cmd, detached: options?.detached });
      return { unref() {} };
    }) as typeof Bun.spawn,
    runManager: async (cmd) => {
      manager.push([...cmd]);
      return 0;
    },
  });
  expect(spawned).toHaveLength(1);
  expect(spawned[0]?.detached).toBe(true);
  const script = spawned[0]?.cmd.join(' ') ?? '';
  expect(script).toContain('unload');
  expect(script).toContain('load');
  expect(script).not.toContain(String(process.pid));
  expect(manager).toEqual([]);
});

test('Darwin TTY serviceRestart boots the job out and bootstraps the rewritten plist in-process', async () => {
  const spawned: string[][] = [];
  const launchd = fakeLaunchd(true);
  await serviceRestart({
    platform: 'darwin',
    env: { XPC_SERVICE_NAME: 'com.aio-proxy.agent', AIO_PROXY_MANAGED: '1' },
    isTTY: true,
    unitInstalled: () => true,
    unitPath: '/tmp/com.aio-proxy.agent.plist',
    writeManagedUnit: async () => '/tmp/com.aio-proxy.agent.plist',
    spawn: ((cmd: string[]) => {
      spawned.push(cmd);
      return { unref() {} };
    }) as typeof Bun.spawn,
    ...launchd,
  });
  expect(spawned).toEqual([]);
  // kickstart -k would restart the old definition; bootout + bootstrap re-reads the rewritten plist.
  expect(launchd.calls).toEqual([
    `launchctl bootout ${launchdJobTarget()}`,
    `launchctl enable ${launchdJobTarget()}`,
    `launchctl bootstrap ${launchdDomain()} /tmp/com.aio-proxy.agent.plist`,
  ]);
});

const restartInProcess = (
  launchd: ReturnType<typeof fakeLaunchd>,
  bootoutTimeoutMs?: number,
  writeManagedUnit: () => Promise<string> = async () => '/tmp/com.aio-proxy.agent.plist',
) =>
  serviceRestart({
    platform: 'darwin',
    env: {},
    isTTY: true,
    unitInstalled: () => true,
    unitPath: '/tmp/com.aio-proxy.agent.plist',
    writeManagedUnit,
    ...(bootoutTimeoutMs === undefined ? {} : { bootoutTimeoutMs }),
    ...launchd,
  });

test('serviceRestart waits for a slow bootout before bootstrapping, instead of kickstarting the dying job', async () => {
  const launchd = fakeLaunchd(true, { teardownPolls: 3 });
  await restartInProcess(launchd);
  expect(launchd.calls).toEqual([
    `launchctl bootout ${launchdJobTarget()}`,
    `launchctl enable ${launchdJobTarget()}`,
    `launchctl bootstrap ${launchdDomain()} /tmp/com.aio-proxy.agent.plist`,
  ]);
});

test('serviceRestart fails when bootout never removes the job, and neither rewrites nor starts anything', async () => {
  const launchd = fakeLaunchd(true, { teardownPolls: Number.POSITIVE_INFINITY });
  const writeManagedUnit = mock(async () => '/tmp/com.aio-proxy.agent.plist');
  const error = await restartInProcess(launchd, 300, writeManagedUnit).catch((caught: unknown) => caught);
  // The plist still names the old binary, so the app keeps offering Take over and can retry.
  expect(writeManagedUnit).not.toHaveBeenCalled();
  expect(error).toBeInstanceOf(CliExit);
  expect((error as CliExit).message).toContain(`launchctl bootout ${launchdJobTarget()}`);
  expect((error as CliExit).message).not.toContain('exit');
  expect(launchd.calls).toEqual([`launchctl bootout ${launchdJobTarget()}`]);
});

const runWrapper = (exec: string) =>
  Bun.spawnSync(['/bin/sh', '-c', LAUNCHD_EXEC_WRAPPER, exec], { stdout: 'ignore', stderr: 'ignore' }).exitCode;

test('the launchd wrapper exits cleanly when its executable is gone, so KeepAlive does not respawn it', () => {
  expect(runWrapper(join(tmpdir(), 'aio-proxy-missing', 'aio-proxy'))).toBe(0);
});

test('the launchd wrapper still reports real failures and remaps only exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-wrapper-'));
  const exitsWith = (code: number) => {
    const path = join(dir, `exit-${code}`);
    writeFileSync(path, `#!/bin/sh\nexit ${code}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  expect(runWrapper(exitsWith(3))).toBe(3);
  expect(runWrapper(exitsWith(1))).toBe(0);
});

test.skipIf(process.platform !== 'darwin')(
  'a desktop-owned unit keeps the symlink path and carries both desktop markers',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-desktop-unit-'));
    const link = join(dir, 'Application Support', 'aio-proxy-desktop', 'bin', 'aio-proxy');
    const target = join(dir, 'com.aio-proxy.agent.plist');
    await writeManagedUnit('darwin', link, target, { AIO_PROXY_DESKTOP_EXEC: link, PATH: '/usr/bin:/bin' });
    const plist = JSON.parse(Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', target]).stdout.toString()) as {
      ProgramArguments: string[];
      EnvironmentVariables: Record<string, string>;
    };
    expect(plist.ProgramArguments[3]).toBe(link);
    expect(plist.EnvironmentVariables['AIO_PROXY_DESKTOP_EXEC']).toBe(link);
    expect(plist.EnvironmentVariables['AIO_PROXY_UPGRADE_METHOD']).toBe('desktop');
  },
);

test.skipIf(process.platform !== 'darwin')(
  'readDesktopOwnedUnit tells a desktop-written unit from a CLI-written one',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-desktop-owned-'));
    const link = join(dir, 'Application Support', 'aio-proxy-desktop', 'bin', 'aio-proxy');
    const desktop = join(dir, 'desktop.plist');
    const cli = join(dir, 'cli.plist');
    await writeManagedUnit('darwin', link, desktop, { AIO_PROXY_DESKTOP_EXEC: link, PATH: '/usr/bin:/bin' });
    await writeManagedUnit('darwin', join(dir, 'brew', 'aio-proxy'), cli, { PATH: '/usr/bin:/bin' });
    expect(readDesktopOwnedUnit(desktop)).toBe(true);
    expect(readDesktopOwnedUnit(cli)).toBe(false);
    expect(readDesktopOwnedUnit(join(dir, 'missing.plist'))).toBe(false);
  },
);
