import { expect, test } from 'bun:test';

import { renderSystemdUnit } from '../../service/unit-templates';
import { unitOwner } from '../launchd-inspect';
import { inspectSystemdUnit, parseSystemctlShow } from './systemd-inspect';

const link = '/home/u/.local/share/aio-proxy-desktop/bin/aio-proxy';

test.each([
  ['no unit, no marker', 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\nMainPID=0', 0, false, false],
  ['no unit, marker', 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\nMainPID=0', 0, true, true],
  ['disabled unit', 'LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\nMainPID=0', 0, false, true],
  ['query failed', '', 1, false, true],
  ['unreadable output', 'garbage', 0, false, true],
])('systemd %s → disabled=%s', (_n, out, code, marker, disabled) => {
  expect(parseSystemctlShow(out, code, marker).disabled).toBe(disabled);
});

test('systemd running unit reports MainPID so matchesJob works', () => {
  expect(
    parseSystemctlShow('LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=812', 0, false),
  ).toEqual({ loaded: true, disabled: false, pid: 812 });
});

test("a unit's program and home are read back from what the CLI writes", () => {
  const text = renderSystemdUnit({ exec: link, configPath: '/home/u/my home/config.jsonc', desktopExec: link });
  const unit = inspectSystemdUnit(text);
  expect(unit).toEqual({ present: true, wrapperValid: true, target: link, home: '/home/u/my home' });
  expect(unitOwner(unit, link, () => true)).toBe('desktop');
});

test('a unit that runs something other than `<exec> run` is unknown', () => {
  const text = renderSystemdUnit({ exec: link, configPath: '/home/u/x/config.jsonc' }).replace(' run\n', ' upgrade\n');
  expect(unitOwner(inspectSystemdUnit(text), link, () => true)).toBe('unknown');
});
