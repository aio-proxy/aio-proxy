import { expect, test } from 'bun:test';

import { CliExit } from '../../exit';
import { type CaptureResult } from '../run-capture';
import {
  parseServiceSpec,
  parseTaskXml,
  renderServiceSpec,
  renderTaskXml,
  serviceSpecPath,
  serviceStatePath,
  taskPath,
} from '../schtasks-unit';
import { uninstallMarkerPath } from '../uninstall-marker';
import {
  currentUser,
  queryTaskXml,
  type SchtasksIo,
  schtasksInstall,
  schtasksRestart,
  schtasksRestartInService,
  schtasksStart,
  schtasksStatus,
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
const account = 'DESKTOP-1\\Zoë';
const oldExec = 'C:\\Users\\Zoë\\old\\aio-proxy.exe';
const oldSpec = JSON.stringify(
  renderServiceSpec({ exec: oldExec, configPath: 'C:\\Users\\Zoë\\.aio-proxy\\config.jsonc' }),
);
// What `/Query /XML` hands back: non-ASCII may not survive the pipe, so it must never be re-registered.
const previousXml = renderTaskXml({ sid, exec: 'C:\\Users\\Zo?\\old\\aio-proxy.exe', specPath });
const oldTaskXml = renderTaskXml({ sid, exec: oldExec, specPath });
// The supervisor records its own image beside its PID.
const supervisorState = JSON.stringify({ pid: 4242, exec: oldExec });

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
let lastWarnings: string[] = [];
const recorded = () => lastCalls;

type Options = {
  readonly fs?: FakeFs;
  /** The command (`/Create`, `/Run`) whose first call fails; `failAlways` fails every call. */
  readonly failOn?: string;
  readonly failAlways?: boolean;
  /** What `/Query /XML` finds: the task XML (default `previousXml`), nothing, or a failure exit code. */
  readonly task?: string | 'missing' | number;
  readonly imagePath?: (pid: number) => string | undefined;
};

function io({
  fs = fakeFs(),
  failOn,
  failAlways = false,
  task = previousXml,
  imagePath = () => undefined,
}: Options = {}): SchtasksIo {
  const calls: string[][] = [];
  const warnings: string[] = [];
  lastCalls = calls;
  lastWarnings = warnings;
  let clock = 0;
  let failed = false;
  return {
    run: async (cmd) => {
      calls.push([...cmd]);
      if (cmd[1] === '/Create') {
        const bytes = fs.files.get(cmd[3]!);
        if (!(bytes instanceof Uint8Array)) throw new Error('task XML was not staged as bytes');
        expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
        fs.created.push(new TextDecoder('utf-16le').decode(bytes));
      }
      if (cmd[1] === failOn && (failAlways || !failed)) {
        failed = true;
        throw new Error(`${failOn} failed`);
      }
      return 0;
    },
    capture: async (cmd): Promise<CaptureResult> => {
      expect(cmd).toEqual(['schtasks', '/Query', '/XML', '/TN', path, '/HRESULT']);
      if (task === 'missing') return { code: 0x80070002, stdout: '', stderr: '' };
      if (typeof task === 'number') return { code: task, stdout: '', stderr: 'Access is denied.' };
      return { code: 0, stdout: task, stderr: '' };
    },
    sid,
    account,
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
    imagePath,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    warn: (line) => void warnings.push(line),
  };
}

async function recordRun(fn: (io: SchtasksIo) => Promise<void>, options: Options = {}) {
  const fs = options.fs ?? fakeFs({ [specPath]: oldSpec, [statePath]: supervisorState });
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

test('stop does nothing for a missing task and refuses a foreign one or a failed query without mutating', async () => {
  expect(await recordCalls((io) => schtasksStop(io), { task: 'missing' })).toEqual([]);
  const foreign = previousXml.replaceAll(sid, 'S-1-5-21-9-9-9-500');
  for (const task of [foreign, 1]) {
    await expect(schtasksStop(io({ task }))).rejects.toBeInstanceOf(CliExit);
    expect(recorded()).toEqual([]);
  }
});

test('start re-enables a stopped task before running it', async () => {
  const calls = await recordCalls((io) => schtasksStart(io));
  expect(calls).toEqual([
    ['schtasks', '/Change', '/TN', path, '/ENABLE'],
    ['schtasks', '/Run', '/TN', path],
  ]);
});

test('start re-creates a task that is missing while the spec is still there, then runs it', async () => {
  const calls = await recordCalls((io) => schtasksStart(io), { task: 'missing' });
  expect(calls.map((c) => c[1])).toEqual(['/Create', '/Run']);
});

test('start fails on a task query failure without touching the task', async () => {
  const fs = fakeFs({ [specPath]: oldSpec });
  await expect(schtasksStart(io({ fs, task: 5 }))).rejects.toBeInstanceOf(CliExit);
  expect(recorded()).toEqual([]);
});

test('start refuses a task at our path that runs as another user without enabling or running it', async () => {
  const fs = fakeFs({ [specPath]: oldSpec });
  const task = previousXml.replaceAll(sid, 'S-1-5-21-9-9-9-500');
  await expect(schtasksStart(io({ fs, task }))).rejects.toBeInstanceOf(CliExit);
  expect(recorded()).toEqual([]);
});

test('install clears the uninstall marker and writes the spec and a UTF-16 task XML together', async () => {
  const marker = uninstallMarkerPath('win32', env)!;
  const fs = fakeFs({ [marker]: '' });
  const calls = await recordCalls((io) => schtasksInstall(io), { fs, task: 'missing' });
  expect(calls.map((c) => c.slice(0, 3))).toEqual([['schtasks', '/Create', '/XML']]);
  expect(calls[0]!.slice(4)).toEqual(['/TN', path, '/F']);
  expect(parseTaskXml(fs.lastXmlCreated()!)).toEqual({
    sid,
    triggerUser: sid,
    enabled: true,
    action: { exec, specPath },
  });
  expect(parseServiceSpec(fs.read(specPath)!)?.exec).toBe(exec);
  expect(fs.exists(marker)).toBe(false);
  expect(onlyFilesBesides(fs)).toEqual([specPath]);
  expect(fs.files.size).toBe(1);
});

test('install replaces a task that already runs as the current user', async () => {
  const calls = await recordCalls((io) => schtasksInstall(io));
  expect(calls.map((c) => c[1])).toEqual(['/Create']);
});

test('install accepts a task whose principal is exported as our account name, in any case', async () => {
  for (const name of [account, account.toUpperCase()]) {
    const calls = await recordCalls((io) => schtasksInstall(io), { task: previousXml.replaceAll(sid, name) });
    expect(calls.map((c) => c[1])).toEqual(['/Create']);
  }
});

test('install refuses a task at our path that runs as another user, and a failed query', async () => {
  const foreignSid = previousXml.replaceAll(sid, 'S-1-5-21-9-9-9-500');
  const foreignAccount = previousXml.replaceAll(sid, 'DESKTOP-1\\other');
  for (const task of [foreignSid, foreignAccount, 1]) {
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
  expect(parseTaskXml(fs.lastXmlCreated()!)?.action?.exec).toBe(exec);
  expect(parseServiceSpec(fs.read(specPath)!)?.exec).toBe(exec);
  expect(onlyFilesBesides(fs).sort()).toEqual([specPath, statePath].sort());
  expect(fs.files.size).toBe(2);
});

test('a managed proxy restarting itself on Windows rewrites the spec and asks its supervisor to relaunch', async () => {
  const exits: [number, number][] = [];
  const { calls, fs } = await recordRun((io) =>
    schtasksRestartInService(io, (code, ms) => void exits.push([code, ms])),
  );
  expect(calls.map((c) => c[1])).toEqual(['/Create']);
  expect(calls[0]).toContain('/F');
  expect(parseTaskXml(fs.lastXmlCreated()!)?.action?.exec).toBe(exec);
  expect(exits).toEqual([[75, 1000]]);
  expect(parseServiceSpec(fs.read(specPath)!)?.exec).toBe(exec);
  expect(onlyFilesBesides(fs).sort()).toEqual([specPath, statePath].sort());
});

test('an in-service restart leaves our unchanged task alone and re-creates a missing one', async () => {
  const exits: number[] = [];
  const same = renderTaskXml({ sid, exec, specPath });
  await recordRun((io) => schtasksRestartInService(io, (code) => void exits.push(code)), { task: same });
  expect(recorded()).toEqual([]);
  await recordRun((io) => schtasksRestartInService(io, (code) => void exits.push(code)), { task: 'missing' });
  expect(recorded().map((c) => c[1])).toEqual(['/Create']);
  expect(exits).toEqual([75, 75]);
});

test('an in-service restart fails closed on a foreign task or a failed query: nothing written, no exit', async () => {
  const foreign = previousXml.replaceAll(sid, 'S-1-5-21-9-9-9-500');
  for (const task of [foreign, 5]) {
    const fs = fakeFs({ [specPath]: oldSpec });
    const exits: number[] = [];
    await expect(schtasksRestartInService(io({ fs, task }), (code) => void exits.push(code))).rejects.toBeInstanceOf(
      CliExit,
    );
    expect(recorded()).toEqual([]);
    expect(fs.read(specPath)).toBe(oldSpec);
    expect(fs.files.size).toBe(1);
    expect(exits).toEqual([]);
  }
});

test('an in-service restart that cannot re-create the task keeps the old spec and does not exit', async () => {
  const fs = fakeFs({ [specPath]: oldSpec });
  const exits: number[] = [];
  await expect(
    schtasksRestartInService(io({ fs, failOn: '/Create' }), (code) => void exits.push(code)),
  ).rejects.toThrow('/Create failed');
  expect(fs.read(specPath)).toBe(oldSpec);
  expect(fs.files.size).toBe(1);
  expect(exits).toEqual([]);
});

test('the default scheduled exit ends the process with 75 after the restart already returned', async () => {
  const dir = import.meta.dir;
  const script = `
    import { schtasksRestartInService, exitProcessLater } from ${JSON.stringify(`${dir}/schtasks.ts`)};
    const files = new Map();
    const io = {
      run: async () => 0,
      capture: async () => ({ code: 0x80070002, stdout: '', stderr: '' }),
      sid: 'S-1-5-21-1', account: 'PC-u', localAppData: 'C:/L', tempDir: 'C:/T',
      unit: async () => ({ exec: 'C:/a.exe', configPath: 'C:/c.jsonc' }),
      readFile: (p) => files.get(p), writeFile: (p, d) => void files.set(p, d),
      rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); }, remove: (p) => void files.delete(p),
      imagePath: () => undefined, sleep: async () => {}, now: Date.now, warn: () => {},
    };
    await schtasksRestartInService(io, exitProcessLater);
    console.log('returned');
  `;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(stdout, await new Response(child.stderr).text()).toContain('returned');
  expect(code).toBe(75);
});

test('a failed re-create re-registers the previous task from our own spec, not from the queried XML', async () => {
  const fs = fakeFs({ [specPath]: oldSpec });
  await expect(schtasksRestart(io({ fs, failOn: '/Create' }))).rejects.toThrow('/Create failed');
  expect(recorded().map((c) => c[1])).toEqual(['/End', '/Create', '/Create', '/Run']);
  expect(fs.lastXmlCreated()).toBe(oldTaskXml);
  expect(fs.read(specPath)).toBe(oldSpec);
  expect(fs.files.size).toBe(1);
  expect(lastWarnings).toEqual([]);
});

test('a failed run after the new spec moved in puts the old spec and task back', async () => {
  const fs = fakeFs({ [specPath]: oldSpec });
  await expect(schtasksRestart(io({ fs, failOn: '/Run' }))).rejects.toThrow('/Run failed');
  expect(recorded().map((c) => c[1])).toEqual(['/End', '/Create', '/Run', '/Create', '/Run']);
  expect(fs.read(specPath)).toBe(oldSpec);
  expect(fs.lastXmlCreated()).toBe(oldTaskXml);
  expect(lastWarnings).toEqual([]);
});

test('a rollback that cannot bring the old task back says so and still reports the original failure', async () => {
  for (const options of [
    { fs: fakeFs({ [specPath]: oldSpec }), failOn: '/Create', failAlways: true },
    { fs: fakeFs(), failOn: '/Create' },
  ]) {
    await expect(schtasksRestart(io(options))).rejects.toThrow('/Create failed');
    expect(lastWarnings).toHaveLength(1);
  }
});

test('uninstall waits for the supervisor to exit before deleting, then leaves the marker', async () => {
  const alive = [true, true, false];
  const asked: number[] = [];
  const { calls, fs } = await recordRun((io) =>
    schtasksUninstall({
      ...io,
      imagePath: (pid) => {
        asked.push(pid);
        return alive.shift() === true ? oldExec : undefined;
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
  const fs = fakeFs({ [specPath]: oldSpec, [statePath]: supervisorState });
  await expect(schtasksUninstall(io({ fs, imagePath: () => oldExec }))).rejects.toBeInstanceOf(CliExit);
  expect(recorded().some((c) => c[1] === '/Delete')).toBe(false);
  expect(fs.exists(specPath)).toBe(true);
});

test('uninstall does not wait on a supervisor PID that another program now holds', async () => {
  const asked: number[] = [];
  const { calls } = await recordRun((io) =>
    schtasksUninstall({
      ...io,
      imagePath: (pid) => {
        asked.push(pid);
        return 'C:\\Windows\\System32\\svchost.exe';
      },
      sleep: async () => {
        throw new Error('waited on a recycled PID');
      },
    }),
  );
  expect(asked).toEqual([4242]);
  expect(calls.map((c) => c[1])).toEqual(['/End', '/Delete']);
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

test('the current user is the account and SID whoami prints as CSV', async () => {
  const whoami = (code: number, stdout: string) => currentUser(async () => ({ code, stdout, stderr: '' }));
  expect(await whoami(0, `"${account}","${sid}"\r\n`)).toEqual({ account, sid });
  await expect(whoami(0, 'garbage')).rejects.toBeInstanceOf(CliExit);
  await expect(whoami(1, '')).rejects.toBeInstanceOf(CliExit);
});

test('status prints the task and succeeds only while the recorded supervisor runs', async () => {
  const fs = fakeFs({ [statePath]: supervisorState });
  const alive = io({ fs, imagePath: () => oldExec });
  expect(await schtasksStatus(alive)).toBe(0);
  expect(recorded().map((c) => c[1])).toEqual(['/Query']);
  expect(await schtasksStatus(io({ fs, imagePath: () => undefined }))).not.toBe(0);
  expect(await schtasksStatus(io({ fs: fakeFs(), imagePath: () => oldExec }))).not.toBe(0);
  expect(await schtasksStatus({ ...alive, run: async () => 1 })).toBe(1);
});
