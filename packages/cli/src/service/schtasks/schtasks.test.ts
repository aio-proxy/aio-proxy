import { expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliExit } from '../../exit';
import { type CaptureResult, runCapture } from '../run-capture';
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
const account = 'DESKTOP-1\\张';
const sidForAccount = (name: string) => (name === account ? sid : name === 'DESKTOP-1\\李' ? 'S-1-5-21-9' : undefined);
const oldExec = 'C:\\Users\\Zoë\\old\\aio-proxy.exe';
const oldSpec = JSON.stringify(
  renderServiceSpec({ exec: oldExec, configPath: 'C:\\Users\\Zoë\\.aio-proxy\\config.jsonc' }),
);
// What the task query hands back: Task Scheduler may have rewritten it, so it must never be re-registered.
const previousXml = renderTaskXml({ sid, exec: 'C:\\Users\\Zo?\\old\\aio-proxy.exe', specPath });
const oldTaskXml = renderTaskXml({ sid, exec: oldExec, specPath });
// The supervisor records its own image beside its PID.
const supervisorState = JSON.stringify({ pid: 4242, exec: oldExec, created: '133000000000000000' });

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
  /** What the task query finds: the task XML (default `previousXml`), nothing, or a failure exit code. */
  readonly task?: string | 'missing' | number;
  readonly imagePath?: (pid: number) => string | undefined;
  readonly kill?: (pid: number) => void;
};

function io({
  fs = fakeFs(),
  failOn,
  failAlways = false,
  task = previousXml,
  imagePath = () => undefined,
  kill = () => {},
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
      expect(cmd[0]).toBe('powershell.exe');
      expect(cmd.at(-1)).toContain(`-TaskPath '\\AIO Proxy\\' -TaskName 'aio-proxy-${sid}'`);
      if (task === 'missing') return { code: 3, stdout: '', stderr: '' };
      if (typeof task === 'number') return { code: task, stdout: '', stderr: 'Access is denied.' };
      return { code: 0, stdout: task, stderr: '' };
    },
    sid,
    sidForAccount,
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
    creationTime: () => '133000000000000000',
    kill,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    warn: (line) => void warnings.push(line),
    exists: fs.exists,
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

/** A supervisor `/End` leaves running (it ends only conhost): alive until killed, and every event in order. */
function survivingSupervisor() {
  const events: string[] = [];
  let running = true;
  return {
    events,
    options: {
      imagePath: () => (running ? oldExec : undefined),
      kill: (pid: number) => {
        events.push(`kill ${pid}`);
        running = false;
      },
    },
    track: (io: SchtasksIo): SchtasksIo => ({
      ...io,
      run: async (cmd, allowFailure) => {
        events.push(cmd[1]!);
        return io.run(cmd, allowFailure);
      },
    }),
  };
}

test('stop, restart and uninstall kill the supervisor that `/End` left running before going on', async () => {
  const flows: [(io: SchtasksIo) => Promise<void>, string[]][] = [
    [schtasksStop, ['/End', 'kill 4242', '/Change']],
    [schtasksRestart, ['/End', 'kill 4242', '/Create', '/Run']],
    [schtasksUninstall, ['/End', 'kill 4242', '/Delete']],
  ];
  for (const [flow, expected] of flows) {
    const supervisor = survivingSupervisor();
    await recordRun((io) => flow(supervisor.track(io)), supervisor.options);
    expect(supervisor.events).toEqual(expected);
  }
});

test('a supervisor that `/End` did end is not killed', async () => {
  const killed: number[] = [];
  await recordRun((io) => schtasksStop(io), { imagePath: () => undefined, kill: (pid) => void killed.push(pid) });
  expect(killed).toEqual([]);
  expect(recorded().map((c) => c[1])).toEqual(['/End', '/Change']);
});

test('restart leaves the task alone and drops its staged files when the old supervisor never dies', async () => {
  const fs = fakeFs({ [specPath]: oldSpec, [statePath]: supervisorState });
  await expect(schtasksRestart(io({ fs, imagePath: () => oldExec }))).rejects.toBeInstanceOf(CliExit);
  expect(recorded().map((c) => c[1])).toEqual(['/End']);
  expect(fs.read(specPath)).toBe(oldSpec);
  expect(onlyFilesBesides(fs).sort()).toEqual([specPath, statePath].sort());
  expect(fs.files.size).toBe(2);
});

test('stop does nothing for a missing task and refuses a foreign one or a failed query without mutating', async () => {
  expect(await recordCalls((io) => schtasksStop(io), { task: 'missing' })).toEqual([]);
  const foreign = previousXml.replaceAll(sid, 'S-1-5-21-9-9-9-500');
  for (const task of [foreign, 1]) {
    await expect(schtasksStop(io({ task }))).rejects.toBeInstanceOf(CliExit);
    expect(recorded()).toEqual([]);
  }
});

test('stop of a deleted task still kills its orphaned supervisor and waits for it', async () => {
  let running = true;
  const killed: number[] = [];
  const calls = await recordCalls(
    (io) =>
      schtasksStop({
        ...io,
        imagePath: () => (running ? oldExec : undefined),
        kill: (pid) => {
          killed.push(pid);
          running = false;
        },
      }),
    { task: 'missing' },
  );
  expect(killed).toEqual([4242]);
  expect(calls).toEqual([]);
});

test('start re-enables a stopped task before running it', async () => {
  const fs = fakeFs({ [specPath]: oldSpec, [exec]: '', [oldExec]: '' });
  const calls = await recordCalls((io) => schtasksStart(io), { fs, task: renderTaskXml({ sid, exec, specPath }) });
  expect(calls).toEqual([
    ['schtasks', '/Change', '/TN', path, '/ENABLE'],
    ['schtasks', '/Run', '/TN', path],
  ]);
});

test('start keeps a task whose recorded exec is still on disk without resolving the unit', async () => {
  // Another binary than the one invoking `start` (and none resolvable at all) is no reason to rewrite the task.
  const fs = fakeFs({ [specPath]: oldSpec, [oldExec]: '' });
  const unit = async () => {
    throw new Error('resolved the unit');
  };
  await schtasksStart({ ...io({ fs, task: oldTaskXml }), unit });
  expect(recorded().map((c) => c[1])).toEqual(['/Change', '/Run']);
});

test('start re-creates a task whose recorded exec is gone before running it', async () => {
  const stale = renderTaskXml({ sid, exec: 'C:\\gone\\cli-1.0.0.exe', specPath });
  expect((await recordCalls((io) => schtasksStart(io), { task: stale })).map((c) => c[1])).toEqual(['/Create', '/Run']);
});

test('start re-creates a task whose spec path moved or whose spec is gone or malformed, though its exec is on disk', async () => {
  const moved = renderTaskXml({ sid, exec: oldExec, specPath: 'C:\\Users\\old\\aio-proxy\\service.json' });
  expect(
    (
      await recordCalls((io) => schtasksStart(io), { fs: fakeFs({ [specPath]: oldSpec, [oldExec]: '' }), task: moved })
    ).map((c) => c[1]),
  ).toEqual(['/Create', '/Run']);
  expect(
    (await recordCalls((io) => schtasksStart(io), { fs: fakeFs({ [oldExec]: '' }), task: oldTaskXml })).map(
      (c) => c[1],
    ),
  ).toEqual(['/Create', '/Run']);
  const truncated = fakeFs({ [specPath]: oldSpec.slice(0, 10), [oldExec]: '' });
  const emptyExec = fakeFs({ [specPath]: '{"exec":"","env":{}}', [oldExec]: '' });
  expect((await recordCalls((io) => schtasksStart(io), { fs: emptyExec, task: oldTaskXml })).map((c) => c[1])).toEqual([
    '/Create',
    '/Run',
  ]);
  const goneExec = fakeFs({
    [specPath]: JSON.stringify(renderServiceSpec({ exec: 'C:\\gone\\aio-proxy.exe', configPath: 'C:\\c.jsonc' })),
    [oldExec]: '',
  });
  expect((await recordCalls((io) => schtasksStart(io), { fs: goneExec, task: oldTaskXml })).map((c) => c[1])).toEqual([
    '/Create',
    '/Run',
  ]);
  expect((await recordCalls((io) => schtasksStart(io), { fs: truncated, task: oldTaskXml })).map((c) => c[1])).toEqual([
    '/Create',
    '/Run',
  ]);
});

test('start repairs a missing or malformed spec when the desktop app starts the service', async () => {
  const desktopUnit = async () => ({ exec, configPath: 'C:\\Users\\Zoë\\.aio-proxy\\config.jsonc', desktopExec: exec });
  for (const files of [{ [oldExec]: '' }, { [specPath]: '{"exec":', [oldExec]: '' }]) {
    const fs = fakeFs(files);
    await schtasksStart({ ...io({ fs, task: oldTaskXml }), unit: desktopUnit });
    expect(recorded().map((c) => c[1])).toEqual(['/Create', '/Run']);
    expect(parseServiceSpec(fs.read(specPath) ?? '')?.exec).toBe(exec);
  }
});

test('start leaves a package-manager-owned service alone when the desktop app resolves a different unit', async () => {
  const external = JSON.stringify(
    renderServiceSpec({ exec: oldExec, configPath: 'C:\\Users\\Zoë\\.aio-proxy\\config.jsonc' }),
  );
  const fs = fakeFs({ [specPath]: external });
  const desktopUnit = async () => ({ exec, configPath: 'C:\\Users\\Zoë\\.aio-proxy\\config.jsonc', desktopExec: exec });
  const run = io({ fs, task: oldTaskXml });
  await schtasksStart({ ...run, unit: desktopUnit });
  expect(recorded().map((c) => c[1])).toEqual(['/Change', '/Run']);
  expect(fs.files.get(specPath)).toBe(external);
});

test('start re-creates a stale desktop-owned task', async () => {
  const owned = JSON.stringify(
    renderServiceSpec({ exec: oldExec, configPath: 'C:\\Users\\Zoë\\.aio-proxy\\config.jsonc', desktopExec: oldExec }),
  );
  const fs = fakeFs({ [specPath]: owned });
  const desktopUnit = async () => ({ exec, configPath: 'C:\\Users\\Zoë\\.aio-proxy\\config.jsonc', desktopExec: exec });
  await schtasksStart({ ...io({ fs, task: oldTaskXml }), unit: desktopUnit });
  expect(recorded().map((c) => c[1])).toEqual(['/Create', '/Run']);
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

test('install accepts a task whose principal is exported as an account name resolving to our SID', async () => {
  const calls = await recordCalls((io) => schtasksInstall(io), { task: previousXml.replaceAll(sid, account) });
  expect(calls.map((c) => c[1])).toEqual(['/Create']);
});

test('install refuses a task at our path that runs as another user, and a failed query', async () => {
  const foreignSid = previousXml.replaceAll(sid, 'S-1-5-21-9-9-9-500');
  const foreignAccount = previousXml.replaceAll(sid, 'DESKTOP-1\\李');
  const unknownAccount = previousXml.replaceAll(sid, 'DESKTOP-1\\other');
  for (const task of [foreignSid, foreignAccount, unknownAccount, 1]) {
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

test('an in-service restart leaves our unchanged task alone and re-creates a missing or stale one', async () => {
  const exits: number[] = [];
  const same = renderTaskXml({ sid, exec: exec.toUpperCase(), specPath: specPath.toUpperCase() });
  await recordRun((io) => schtasksRestartInService(io, (code) => void exits.push(code)), { task: same });
  expect(recorded()).toEqual([]);
  await recordRun((io) => schtasksRestartInService(io, (code) => void exits.push(code)), { task: 'missing' });
  expect(recorded().map((c) => c[1])).toEqual(['/Create']);
  // Same exec, but the supervisor would re-read a spec this restart never wrote.
  const staleSpec = renderTaskXml({ sid, exec, specPath: 'C:\\Users\\Zoë\\old\\service.json' });
  await recordRun((io) => schtasksRestartInService(io, (code) => void exits.push(code)), { task: staleSpec });
  expect(recorded().map((c) => c[1])).toEqual(['/Create']);
  expect(exits).toEqual([75, 75, 75]);
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
      capture: async () => ({ code: 3, stdout: '', stderr: '' }),
      sid: 'S-1-5-21-1', sidForAccount: () => undefined, localAppData: 'C:/L', tempDir: 'C:/T',
      unit: async () => ({ exec: 'C:/a.exe', configPath: 'C:/c.jsonc' }),
      readFile: (p) => files.get(p), writeFile: (p, d) => void files.set(p, d),
      rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); }, remove: (p) => void files.delete(p),
      imagePath: () => undefined, creationTime: () => undefined, sleep: async () => {}, now: Date.now, warn: () => {},
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

test('uninstall neither kills nor waits on a supervisor PID that another program now holds', async () => {
  const asked: number[] = [];
  const { calls } = await recordRun((io) =>
    schtasksUninstall({
      ...io,
      kill: () => {
        throw new Error('killed a recycled PID');
      },
      imagePath: (pid) => {
        asked.push(pid);
        return 'C:\\Windows\\System32\\svchost.exe';
      },
      sleep: async () => {
        throw new Error('waited on a recycled PID');
      },
    }),
  );
  expect(asked).toEqual([4242, 4242]);
  expect(calls.map((c) => c[1])).toEqual(['/End', '/Delete']);
});

test('uninstall of a deleted task still kills a live supervisor, waits for it, then removes the files', async () => {
  let running = true;
  const killed: number[] = [];
  const { calls, fs } = await recordRun(
    (io) =>
      schtasksUninstall({
        ...io,
        imagePath: () => (running ? oldExec : undefined),
        kill: (pid) => {
          killed.push(pid);
          running = false;
        },
      }),
    { task: 'missing' },
  );
  expect(killed).toEqual([4242]);
  expect(calls).toEqual([]);
  expect(fs.exists(specPath)).toBe(false);
  expect(fs.exists(uninstallMarkerPath('win32', env)!)).toBe(true);
});

test('uninstall of a deleted task goes on when the supervisor exits just before the kill', async () => {
  let checks = 0;
  const { fs } = await recordRun(
    (io) =>
      schtasksUninstall({
        ...io,
        imagePath: () => (checks++ === 0 ? oldExec : undefined),
        kill: () => {
          throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        },
      }),
    { task: 'missing' },
  );
  expect(fs.exists(uninstallMarkerPath('win32', env)!)).toBe(true);
});

test('uninstall of a deleted task fails and keeps the spec when the orphaned supervisor never dies', async () => {
  const fs = fakeFs({ [specPath]: oldSpec, [statePath]: supervisorState });
  await expect(schtasksUninstall(io({ fs, task: 'missing', imagePath: () => oldExec }))).rejects.toBeInstanceOf(
    CliExit,
  );
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
  expect(await query(3)).toEqual({ kind: 'missing' });
  expect(await query(1)).toEqual({ kind: 'failed', code: 1 });
});

test('the current user comes from the token, and whoami is only the fallback when that fails', async () => {
  const native = { sid, account: 'DESKTOP-1\\张三' };
  const failing = async () => {
    throw new Error('whoami must not run');
  };
  expect(await currentUser(failing, () => native)).toEqual(native);
  const whoami = (code: number, stdout: string) =>
    currentUser(
      async () => ({ code, stdout, stderr: '' }),
      () => undefined,
    );
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

// Settles whether `/Create /XML /TN \\Folder\\Name` makes a missing folder, as schtasksInstall relies on.
test.skipIf(process.platform !== 'win32')(
  'schtasks creates a task under a folder that does not exist yet',
  async () => {
    const { sid: ownSid } = await currentUser(runCapture);
    const folder = `AIO Proxy Test ${process.pid}`;
    const taskName = `\\${folder}\\aio-proxy-${ownSid}`;
    const file = join(tmpdir(), `aio-proxy-task-test-${process.pid}.xml`);
    const xml = renderTaskXml({ sid: ownSid, exec: process.execPath, specPath: join(tmpdir(), 'service.json') });
    writeFileSync(file, Buffer.from(`\uFEFF${xml}`, 'utf16le'));
    try {
      const created = await runCapture(['schtasks', '/Create', '/XML', file, '/TN', taskName, '/F']);
      expect(created.code, created.stderr).toBe(0);
      expect((await queryTaskXml(runCapture, taskName)).kind).toBe('found');
    } finally {
      rmSync(file, { force: true });
      await runCapture(['schtasks', '/Delete', '/TN', taskName, '/F']);
      await runCapture([
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s = New-Object -ComObject Schedule.Service; $s.Connect(); $s.GetFolder('\\').DeleteFolder('${folder}', 0)`,
      ]);
    }
  },
);
