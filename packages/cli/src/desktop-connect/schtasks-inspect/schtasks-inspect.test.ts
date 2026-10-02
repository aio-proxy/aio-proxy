import { expect, test } from 'bun:test';

import { renderServiceSpec, renderTaskXml, serviceSpecPath, serviceStatePath } from '../../service/schtasks-unit';
import { unitOwner } from '../launchd-inspect';
import { inspectTask, readTask, taskJob } from './schtasks-inspect';

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
  expect(taskJob(query, marker, null).disabled).toBe(disabled);
});

test('Windows job pid is the running supervisor, reported only for a task that exists', () => {
  const found = { kind: 'found', xml: xmlFor(sid) } as const;
  expect(taskJob(found, false, 77)).toEqual({ loaded: true, disabled: false, pid: 77 });
  expect(taskJob(found, false, null).pid).toBeNull();
  expect(taskJob({ kind: 'missing' }, false, 77).pid).toBeNull();
});

// The supervisor keeps running from the image it started with while an in-service restart points the spec
// (and the task) at a new exec; until it relaunches, it is still the job.
test('discovery after an exec change still reports the running supervisor, and not a recycled PID', async () => {
  const localAppData = 'C:\\Users\\Ada\\AppData\\Local';
  const unitPath = serviceSpecPath(localAppData);
  const moved = 'C:\\Users\\Ada\\.bun\\install\\global\\node_modules\\aio-proxy-1.2.0\\aio-proxy.exe';
  const read = (imagePath: (pid: number) => string | undefined) =>
    readTask({
      env: { LOCALAPPDATA: localAppData },
      unitPath,
      imagePath,
      run: async (cmd) =>
        cmd[0] === 'whoami'
          ? { code: 0, stdout: `"${user.account}","${sid}"\r\n` }
          : { code: 0, stdout: renderTaskXml({ sid, exec: moved, specPath: unitPath }) },
      readFile: async (path) => {
        if (path === unitPath) return specFor(moved);
        if (path === serviceStatePath(localAppData)) return JSON.stringify({ pid: 4310, exec: link });
        throw new Error(`ENOENT ${path}`);
      },
    });
  expect((await read((pid) => (pid === 4310 ? link : undefined))).job.pid).toBe(4310);
  expect((await read(() => 'C:\\Windows\\System32\\svchost.exe')).job.pid).toBeNull();
});
