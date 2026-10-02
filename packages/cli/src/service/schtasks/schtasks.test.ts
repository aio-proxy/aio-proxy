import { expect, test } from 'bun:test';

import { CliExit } from '../../exit';
import { type CaptureResult } from '../run-capture';
import {
  parseServiceSpec,
  parseTaskXml,
  renderTaskXml,
  serviceSpecPath,
  serviceStatePath,
  taskPath,
} from '../schtasks-unit';
import { uninstallMarkerPath } from '../uninstall-marker';
import {
  currentUserSid,
  queryTaskXml,
  type SchtasksIo,
  schtasksInstall,
  schtasksRestart,
  schtasksStart,
  schtasksStop,
  schtasksUninstall,
} from './schtasks';

const sid = 'S-1-5-21-1-2-3-1001';
const localAppData = 'C:\\Users\\Zoë\\AppData\\Local';
const env = { LOCALAPPDATA: localAppData };
const path = taskPath(sid);
const specPath = serviceSpecPath(localAppData);
const statePath = serviceStatePath(localAppData);
const exec = 'C:\\Users\\Zoë\\AppData\\Local\\aio-proxy-desktop\\bin\\aio-proxy.exe';
const previousXml = renderTaskXml({ sid, exec: 'C:\\old\\aio-proxy.exe', specPath });

type FakeFs = ReturnType<typeof fakeFs>;

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string | Uint8Array>(Object.entries(initial));
  const created: string[] = [];
  return {
    files,
    created,
    read: (p: string) => {
      const value = files.get(p);
      return typeof value === 'string' ? value : undefined;
    },
    exists: (p: string) => files.has(p),
    lastXmlCreated: () => created.at(-1),
  };
}

let lastCalls: string[][] = [];
const recorded = () => lastCalls;

type Options = {
  readonly fs?: FakeFs;
  readonly failOn?: string;
  /** What `/Query /XML` finds: the task XML (default `previousXml`), nothing, or a failure exit code. */
  readonly task?: string | 'missing' | number;
  readonly pidAlive?: (pid: number) => boolean;
};

function io({ fs = fakeFs(), failOn, task = previousXml, pidAlive = () => false }: Options = {}): SchtasksIo {
  const calls: string[][] = [];
  lastCalls = calls;
  let clock = 0;
  return {
    run: async (cmd) => {
      calls.push([...cmd]);
      if (cmd[1] === '/Create') {
        const bytes = fs.files.get(cmd[3]!);
        if (!(bytes instanceof Uint8Array)) throw new Error('task XML was not staged as bytes');
        expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
        fs.created.push(new TextDecoder('utf-16le').decode(bytes));
      }
      if (cmd[1] === failOn) throw new Error(`${failOn} failed`);
      return 0;
    },
    capture: async (cmd): Promise<CaptureResult> => {
      expect(cmd).toEqual(['schtasks', '/Query', '/XML', '/TN', path, '/HRESULT']);
      if (task === 'missing') return { code: 0x80070002, stdout: '', stderr: '' };
      if (typeof task === 'number') return { code: task, stdout: '', stderr: 'Access is denied.' };
      return { code: 0, stdout: task, stderr: '' };
    },
    sid,
    localAppData,
    tempDir: 'C:\\Temp',
    unit: async () => ({ exec, configPath: 'C:\\Users\\Zoë\\.aio-proxy\\config.jsonc' }),
    readFile: fs.read,
    writeFile: (p, data) => void fs.files.set(p, data),
    rename: (from, to) => {
      const data = fs.files.get(from);
      if (data === undefined) throw new Error(`ENOENT ${from}`);
      fs.files.delete(from);
      fs.files.set(to, data);
    },
    remove: (p) => void fs.files.delete(p),
    pidAlive,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  };
}

async function recordRun(fn: (io: SchtasksIo) => Promise<void>, options: Options = {}) {
  const fs = options.fs ?? fakeFs({ [specPath]: 'old-spec', [statePath]: '{"pid":4242}' });
  await fn(io({ ...options, fs }));
  return { calls: recorded(), fs };
}

const recordCalls = async (fn: (io: SchtasksIo) => Promise<void>, options?: Options) =>
  (await recordRun(fn, options)).calls;

const onlyFilesBesides = (fs: FakeFs) => [...fs.files.keys()].filter((p) => !p.startsWith('C:\\Temp\\'));

test('stop ends the task and disables it so the stop survives a logon', async () => {
  const calls = await recordCalls((io) => schtasksStop(io));
  expect(calls).toEqual([
    ['schtasks', '/End', '/TN', path],
    ['schtasks', '/Change', '/TN', path, '/DISABLE'],
  ]);
});

test('start re-enables a stopped task before running it', async () => {
  const calls = await recordCalls((io) => schtasksStart(io));
  expect(calls).toEqual([
    ['schtasks', '/Change', '/TN', path, '/ENABLE'],
    ['schtasks', '/Run', '/TN', path],
  ]);
});

test('install clears the uninstall marker and writes the spec and a UTF-16 task XML together', async () => {
  const marker = uninstallMarkerPath('win32', env)!;
  const fs = fakeFs({ [marker]: '' });
  const calls = await recordCalls((io) => schtasksInstall(io), { fs, task: 'missing' });
  expect(calls.map((c) => c.slice(0, 3))).toEqual([['schtasks', '/Create', '/XML']]);
  expect(calls[0]!.slice(4)).toEqual(['/TN', path, '/F']);
  expect(parseTaskXml(fs.lastXmlCreated()!)).toEqual({ sid, exec, specPath });
  expect(parseServiceSpec(fs.read(specPath)!)?.exec).toBe(exec);
  expect(fs.exists(marker)).toBe(false);
  expect(onlyFilesBesides(fs)).toEqual([specPath]);
  expect(fs.files.size).toBe(1);
});

test('install replaces a task that already runs as the current user', async () => {
  const calls = await recordCalls((io) => schtasksInstall(io));
  expect(calls.map((c) => c[1])).toEqual(['/Create']);
});

test('install refuses a task at our path that runs as another user, and a failed query', async () => {
  const foreign = previousXml.replaceAll(sid, 'S-1-5-21-9-9-9-500');
  for (const task of [foreign, 1]) {
    const fs = fakeFs();
    const rejection = expect(schtasksInstall(io({ fs, task }))).rejects;
    await rejection.toBeInstanceOf(CliExit);
    expect(recorded()).toEqual([]);
    expect(fs.files.size).toBe(0);
  }
});

test('restart after stop rewrites XML and spec, re-creates the task enabled, then runs it', async () => {
  const { calls, fs } = await recordRun((io) => schtasksRestart(io));
  expect(calls.map((c) => c[1])).toEqual(['/End', '/Create', '/Run']);
  expect(calls[1]).toContain('/F');
  expect(parseTaskXml(fs.lastXmlCreated()!)?.exec).toBe(exec);
  expect(parseServiceSpec(fs.read(specPath)!)?.exec).toBe(exec);
  expect(onlyFilesBesides(fs).sort()).toEqual([specPath, statePath].sort());
  expect(fs.files.size).toBe(2);
});

test('a failed re-create restores the previous XML and spec', async () => {
  const fs = fakeFs({ [specPath]: 'old-spec' });
  await expect(schtasksRestart(io({ fs, failOn: '/Create' }))).rejects.toThrow();
  expect(fs.read(specPath)).toBe('old-spec');
  expect(fs.lastXmlCreated()).toBe(previousXml);
  expect(fs.files.size).toBe(1);
});

test('a failed run after the new spec moved in puts the old spec and task back', async () => {
  const fs = fakeFs({ [specPath]: 'old-spec' });
  await expect(schtasksRestart(io({ fs, failOn: '/Run' }))).rejects.toThrow('/Run failed');
  expect(fs.read(specPath)).toBe('old-spec');
  expect(fs.lastXmlCreated()).toBe(previousXml);
});

test('uninstall waits for the supervisor to exit before deleting, then leaves the marker', async () => {
  const alive = [true, true, false];
  const asked: number[] = [];
  const { calls, fs } = await recordRun((io) =>
    schtasksUninstall({
      ...io,
      pidAlive: (pid) => {
        asked.push(pid);
        return alive.shift() ?? false;
      },
    }),
  );
  expect(calls.map((c) => c[1])).toEqual(['/End', '/Delete']);
  expect(calls[1]).toContain('/F');
  expect(asked).toEqual([4242, 4242, 4242]);
  expect(fs.exists(specPath)).toBe(false);
  expect(fs.exists(statePath)).toBe(false);
  expect(fs.exists(uninstallMarkerPath('win32', env)!)).toBe(true);
});

test('uninstall fails without deleting when the supervisor outlives 10 s', async () => {
  const fs = fakeFs({ [specPath]: 'old-spec', [statePath]: '{"pid":4242}' });
  await expect(schtasksUninstall(io({ fs, pidAlive: () => true }))).rejects.toBeInstanceOf(CliExit);
  expect(recorded().some((c) => c[1] === '/Delete')).toBe(false);
  expect(fs.exists(specPath)).toBe(true);
});

test('uninstall of a task that no longer exists still removes the files and leaves the marker', async () => {
  const { calls, fs } = await recordRun((io) => schtasksUninstall(io), { task: 'missing' });
  expect(calls).toEqual([]);
  expect(fs.exists(specPath)).toBe(false);
  expect(fs.exists(uninstallMarkerPath('win32', env)!)).toBe(true);
});

test('a task query tells "does not exist" apart from every other failure', async () => {
  const query = (code: number) =>
    queryTaskXml(async () => ({ code, stdout: code === 0 ? '<Task/>' : '', stderr: '' }), path);
  expect(await query(0)).toEqual({ kind: 'found', xml: '<Task/>' });
  expect(await query(0x80070002)).toEqual({ kind: 'missing' });
  expect(await query(-2147024894)).toEqual({ kind: 'missing' });
  expect(await query(0x80070005)).toEqual({ kind: 'failed', code: 0x80070005 });
  expect(await query(1)).toEqual({ kind: 'failed', code: 1 });
});

test('the current user SID is the second whoami CSV field', async () => {
  const whoami = (code: number, stdout: string) => currentUserSid(async () => ({ code, stdout, stderr: '' }));
  expect(await whoami(0, `"desktop-1\\zoë","${sid}"\r\n`)).toBe(sid);
  await expect(whoami(0, 'garbage')).rejects.toBeInstanceOf(CliExit);
  await expect(whoami(1, '')).rejects.toBeInstanceOf(CliExit);
});
