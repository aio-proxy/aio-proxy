import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliExit } from '../exit';
import { resolveStableManagedExec } from '../upgrade/detect';
import { renderLaunchdPlist, renderSystemdUnit, resolveExec, serviceRestart, writeManagedUnit } from './service';

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

test('Darwin TTY serviceRestart unloads in-process and does not spawn a detached helper', async () => {
  const spawned: string[][] = [];
  const manager: string[][] = [];
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
    runManager: async (cmd) => {
      manager.push([...cmd]);
      return 0;
    },
  });
  expect(spawned).toEqual([]);
  expect(manager.some((cmd) => cmd.includes('unload'))).toBe(true);
  expect(manager.some((cmd) => cmd.includes('load'))).toBe(true);
});
