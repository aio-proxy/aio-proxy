import { expect, test } from 'bun:test';

import { CliExit } from '../exit';
import { renderLaunchdPlist, renderSystemdUnit, resolveExec } from './service';

test('systemd unit runs `run`, restarts on failure, skips exit 1', () => {
  const unit = renderSystemdUnit({ exec: '/usr/local/bin/aio-proxy', configPath: '/home/u/.aio-proxy/config.jsonc' });
  expect(unit).toContain('ExecStart=/usr/local/bin/aio-proxy run');
  expect(unit).toContain('Restart=on-failure');
  expect(unit).toContain('RestartPreventExitStatus=1');
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
});

test('resolveExec returns the aio-proxy bin found on PATH', () => {
  expect(resolveExec(() => '/usr/local/bin/aio-proxy')).toBe('/usr/local/bin/aio-proxy');
});

test('resolveExec fails fast when aio-proxy is not on PATH', () => {
  // Falling back to the interpreter path would render `ExecStart=<bun> run`, an
  // invalid unit that never starts; installing must refuse instead.
  let caught: unknown;
  try {
    resolveExec(() => null);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CliExit);
  expect((caught as CliExit).code).toBe(1);
});
