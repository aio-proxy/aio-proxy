import { expect, test } from 'bun:test';

import { renderServiceSpec, renderTaskXml } from '../../service/schtasks-unit';
import { unitOwner } from '../launchd-inspect';
import { inspectTask, pidAliveAs, taskJob } from './schtasks-inspect';

const sid = 'S-1-5-21-1-2-3-1001';
const user = { sid, account: 'DESKTOP-1\\Ada' };
const specPath = 'C:\\Users\\Ada\\AppData\\Local\\aio-proxy\\service.json';
const link = 'C:\\Users\\Ada\\AppData\\Local\\aio-proxy-desktop\\bin\\aio-proxy.exe';
const home = 'C:\\Users\\Ada\\.aio-proxy';

const xmlFor = (principal: string, exec = link, spec = specPath) =>
  renderTaskXml({ sid: principal, exec, specPath: spec });
const specFor = (exec = link) =>
  JSON.stringify(renderServiceSpec({ exec, configPath: `${home}\\config.jsonc`, desktopExec: exec }));

test('a task of this user that runs the spec it names is the unit', () => {
  const unit = inspectTask(xmlFor(sid), specFor(), user, specPath);
  expect(unit).toEqual({ present: true, wrapperValid: true, target: link, home });
  expect(unitOwner(unit, link, () => true)).toBe('desktop');
});

test('a principal given as the account name matches case-insensitively', () => {
  expect(inspectTask(xmlFor('desktop-1\\ada'), specFor(), user, specPath).wrapperValid).toBe(true);
});

test('a trigger user spelled as the account beside a SID principal is still ours; another account is not', () => {
  const withTrigger = (name: string) => xmlFor(sid).replace(/(<LogonTrigger>[\s\S]*?<UserId>)[^<]*/u, `$1${name}`);
  expect(inspectTask(withTrigger('desktop-1\\ADA'), specFor(), user, specPath).wrapperValid).toBe(true);
  expect(unitOwner(inspectTask(withTrigger('DESKTOP-1\\Bob'), specFor(), user, specPath), link, () => true)).toBe(
    'unknown',
  );
});

test('a task owned by another principal, or running something else, is unknown', () => {
  expect(unitOwner(inspectTask(xmlFor('S-1-5-21-9'), specFor(), user, specPath), link, () => true)).toBe('unknown');
  expect(
    unitOwner(inspectTask(xmlFor(sid).replace('__service-run', 'run'), specFor(), user, specPath), link, () => true),
  ).toBe('unknown');
  // The task runs another program than the spec says, or reads another spec file.
  expect(inspectTask(xmlFor(sid, 'C:\\evil.exe'), specFor(), user, specPath).wrapperValid).toBe(false);
  expect(inspectTask(xmlFor(sid, link, 'C:\\x\\service.json'), specFor(), user, specPath).wrapperValid).toBe(false);
  expect(inspectTask(xmlFor(sid), undefined, user, specPath).wrapperValid).toBe(false);
  expect(inspectTask(undefined, specFor(), user, specPath).wrapperValid).toBe(false);
});

// schtasks' XML output encoding is unverified: a non-ASCII path may come back mangled, so only its ASCII
// letters are compared, and the reported target is the spec's own text.
test('non-ASCII path text from the queried task is compared by its ASCII letters only', () => {
  const exec = 'C:\\Users\\张三\\AppData\\Local\\aio-proxy-desktop\\bin\\aio-proxy.exe';
  const mangled = xmlFor(sid, exec.replace('张三', '\uFFFD\uFFFD\uFFFD'), specPath.toUpperCase());
  const unit = inspectTask(mangled, specFor(exec), user, specPath);
  expect(unit).toMatchObject({ wrapperValid: true, target: exec });
});

test.each([
  ['no task, no marker', { kind: 'missing' } as const, false, false],
  ['no task, marker', { kind: 'missing' } as const, true, true],
  [
    'disabled task',
    { kind: 'found', xml: xmlFor(sid).replace(/(<Settings>[\s\S]*?<Enabled>)true/u, '$1false') } as const,
    false,
    true,
  ],
  ['enabled task', { kind: 'found', xml: xmlFor(sid) } as const, true, false],
  ['query failed', { kind: 'failed', code: 1 } as const, false, true],
  ['unreadable XML', { kind: 'found', xml: 'garbage' } as const, false, true],
])('Windows %s → disabled=%s', (_n, query, marker, disabled) => {
  expect(taskJob(query, marker, undefined, link, () => true).disabled).toBe(disabled);
});

test('Windows job pid comes from the state file only while that process runs exec', () => {
  const found = { kind: 'found', xml: xmlFor(sid) } as const;
  expect(taskJob(found, false, 77, link, () => true)).toEqual({ loaded: true, disabled: false, pid: 77 });
  expect(taskJob(found, false, 77, link, () => false).pid).toBeNull();
  expect(taskJob(found, false, 77, null, () => true).pid).toBeNull();
});

test('a process with the same image name in another directory is not the job', () => {
  const imagePath = (pid: number) => (pid === 77 ? 'C:\\Other\\aio-proxy.exe' : undefined);
  expect(pidAliveAs(77, link, imagePath)).toBe(false);
  expect(pidAliveAs(78, link, imagePath)).toBe(false);
  expect(pidAliveAs(77, link, () => link.toUpperCase())).toBe(true);
});
