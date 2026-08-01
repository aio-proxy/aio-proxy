import { expect, test } from 'bun:test';

import { CliExit } from '../exit';
import { renderLaunchdPlist, renderSystemdUnit, resolveExec } from './service';

test('systemd unit runs `run`, restarts on failure, skips exit 1', () => {
  const unit = renderSystemdUnit({ exec: '/usr/local/bin/aio-proxy', configPath: '/home/u/.aio-proxy/config.jsonc' });
  expect(unit).toContain('ExecStart="/usr/local/bin/aio-proxy" run');
  expect(unit).toContain('Restart=on-failure');
  expect(unit).toContain('RestartPreventExitStatus=1');
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
    ),
  ).toBe(execPath);
});

test('resolveExec falls back to PATH when execPath is not the native binary', () => {
  // e.g. dev `bun run`: execPath is the bun interpreter, so resolve via PATH.
  const launcher = '/usr/local/bin/aio-proxy';
  expect(
    resolveExec(
      () => launcher,
      '/opt/homebrew/bin/bun',
      (p) => p,
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
    );
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CliExit);
  expect((caught as CliExit).code).toBe(1);
});
