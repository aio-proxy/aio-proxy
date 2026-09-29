import { expect, test } from 'bun:test';

import { LAUNCHD_EXEC_WRAPPER, LEGACY_LAUNCHD_EXEC_WRAPPERS } from '../service';
import { inspectUnit, parseDisabled, parseJobPrint, unitOwner } from './launchd-inspect';

const plist = (args: unknown, env: Record<string, string> = { AIO_PROXY_HOME: '/Users/u/.aio-proxy' }) => ({
  ProgramArguments: args,
  EnvironmentVariables: env,
});

test('reads the target and home from a current or legacy wrapper', () => {
  for (const wrapper of [LAUNCHD_EXEC_WRAPPER, ...LEGACY_LAUNCHD_EXEC_WRAPPERS]) {
    expect(inspectUnit(plist(['/bin/sh', '-c', wrapper, '/x/aio-proxy']))).toEqual({
      present: true,
      wrapperValid: true,
      target: '/x/aio-proxy',
      home: '/Users/u/.aio-proxy',
    });
  }
});

test('an unrecognized wrapper is reported invalid with no target', () => {
  expect(inspectUnit(plist(['/usr/local/bin/aio-proxy', 'run']))).toEqual({
    present: true,
    wrapperValid: false,
    target: null,
    home: '/Users/u/.aio-proxy',
  });
});

test('a hand-edited plist without AIO_PROXY_HOME reports no home', () => {
  expect(inspectUnit(plist(['/bin/sh', '-c', LAUNCHD_EXEC_WRAPPER, '/x/aio-proxy'], {})).home).toBeNull();
  expect(inspectUnit({ ProgramArguments: ['/bin/sh', '-c', LAUNCHD_EXEC_WRAPPER, '/x/aio-proxy'] }).home).toBeNull();
});

test('owner compares the wrapper target with the desktop symlink', () => {
  const unit = inspectUnit(plist(['/bin/sh', '-c', LAUNCHD_EXEC_WRAPPER, '/link/aio-proxy']));
  expect(unitOwner(unit, '/link/aio-proxy')).toBe('desktop');
  expect(unitOwner(unit, '/other/aio-proxy')).toBe('external');
  expect(unitOwner(unit, undefined)).toBe('external');
  expect(unitOwner(inspectUnit(plist(['/bin/sh', '-c', LAUNCHD_EXEC_WRAPPER, ''])), '')).toBe('external');
  expect(unitOwner(inspectUnit(plist(['/usr/local/bin/aio-proxy', 'run'])), '/link/aio-proxy')).toBe('unknown');
  expect(unitOwner({ present: false, wrapperValid: false, target: null, home: null }, '/link/aio-proxy')).toBeNull();
});

test('parses launchctl print for a running, a stopped, and an unloaded job', () => {
  expect(parseJobPrint(0, 'gui/501/com.aio-proxy.agent = {\n\tstate = running\n\tpid = 4312\n}')).toEqual({
    loaded: true,
    pid: 4312,
  });
  expect(parseJobPrint(0, 'gui/501/com.aio-proxy.agent = {\n\tstate = not running\n}')).toEqual({
    loaded: true,
    pid: null,
  });
  expect(parseJobPrint(113, 'Could not find service')).toEqual({ loaded: false, pid: null });
});

test('parses print-disabled in both the current and the older boolean format', () => {
  expect(parseDisabled('disabled services = {\n\t"com.aio-proxy.agent" => disabled\n}')).toBe(true);
  expect(parseDisabled('disabled services = {\n\t"com.aio-proxy.agent" => enabled\n}')).toBe(false);
  expect(parseDisabled('disabled services = {\n\t"com.aio-proxy.agent" => true\n}')).toBe(true);
  expect(parseDisabled('disabled services = {\n\t"com.other" => disabled\n}')).toBe(false);
});
