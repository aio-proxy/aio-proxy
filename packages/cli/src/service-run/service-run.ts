import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { EXIT } from '../exit';
import { parseServiceSpec, serviceStatePathBeside, type ServiceSpec } from '../service/schtasks-unit';
import type { SupervisorState } from '../service/supervisor-state';
import { assignToJob, createKillOnCloseJob, processCreationTime } from '../win32-ffi';

export type Decision = 'stop' | 'relaunch-now' | 'relaunch-later';

export type SupervisorDeps = {
  readSpec(path: string): ServiceSpec | undefined;
  exists(path: string): boolean;
  spawnChild(exec: string, env: Readonly<Record<string, string>>): Promise<number>;
  writeState(pid: number): void;
  sleep(ms: number): Promise<void>;
  pid: number;
};

const RELAUNCH_DELAY_MS = 5000;

// Reproduces the systemd unit (Restart=on-failure, RestartSec=5, RestartPreventExitStatus=1), which Task
// Scheduler cannot express: its restart setting reacts only to launch failures, never to exit codes.
export function decide(exitCode: number): Decision {
  if (exitCode === EXIT.ok || exitCode === EXIT.unrecoverable) return 'stop';
  if (exitCode === EXIT.restartRequested) return 'relaunch-now';
  return 'relaunch-later';
}

export async function runSupervisor(specPath: string, deps: SupervisorDeps): Promise<number> {
  deps.writeState(deps.pid);
  for (;;) {
    // Re-read on every launch so an in-service restart (exit 75) picks up a rewritten spec.
    const spec = deps.readSpec(specPath);
    if (spec === undefined) return EXIT.unrecoverable;
    // A removed binary means the service was uninstalled or is mid-replace; mirrors launchd's `[ -x "$0" ] || exit 0`.
    if (!deps.exists(spec.exec)) return EXIT.ok;
    // A launch that throws (exec mid-replace, denied, not executable, job assignment failed) is a crash like
    // any other: Task Scheduler never restarts on exit codes, so dying here would leave the proxy down.
    const code = await deps.spawnChild(spec.exec, spec.env).catch(() => EXIT.transient);
    const decision = decide(code);
    if (decision === 'stop') return code;
    if (decision === 'relaunch-later') await deps.sleep(RELAUNCH_DELAY_MS);
  }
}

export function defaultSupervisorDeps(specPath: string): SupervisorDeps {
  // Created once and never closed: the handle dies with this process, and kill-on-close then ends the proxy,
  // which is how `schtasks /End` (terminating the supervisor) reaches the child.
  const job = process.platform === 'win32' ? createKillOnCloseJob() : undefined;
  return {
    readSpec: (path) => {
      try {
        return parseServiceSpec(readFileSync(path, 'utf8'));
      } catch {
        return undefined;
      }
    },
    exists: existsSync,
    spawnChild: async (exec, env) => {
      const child = Bun.spawn([exec, 'run'], {
        env: { ...process.env, ...env },
        windowsHide: true,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      if (job !== undefined) {
        try {
          assignToJob(job, child.pid);
        } catch (err) {
          // A child outside the job would outlive `/End`; do not leave it running unsupervised.
          child.kill();
          throw err;
        }
      }
      return child.exited;
    },
    // Image and start time are recorded so a reader can tell this supervisor from a later process given the same PID.
    writeState: (pid) =>
      writeFileSync(
        serviceStatePathBeside(specPath),
        JSON.stringify({
          pid,
          exec: process.execPath,
          created: processCreationTime(pid) ?? '',
        } satisfies SupervisorState),
      ),
    sleep: (ms) => Bun.sleep(ms),
    pid: process.pid,
  };
}
