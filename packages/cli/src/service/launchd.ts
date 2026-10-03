import { homedir } from 'node:os';
import { join } from 'node:path';

import { m } from '@aio-proxy/i18n';

import { CliExit, EXIT } from '../exit';
import { LAUNCHD_LABEL } from './unit-templates';

export function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export const launchdDomain = (uid: number = process.getuid?.() ?? 0): string => `gui/${uid}`;

export const launchdJobTarget = (uid?: number): string => `${launchdDomain(uid)}/${LAUNCHD_LABEL}`;

// `launchctl print` exits 0 only while launchd holds the job: the one reliable "is it loaded" check.
export const printLaunchdJob = async (): Promise<number> =>
  Bun.spawn(['launchctl', 'print', launchdJobTarget()], { stdout: 'ignore', stderr: 'ignore' }).exited;

// Legacy `load`/`unload` exit 0 even on "Load failed: 5", so success is read back from launchd, not
// taken from an exit status. `bootstrap` and `kickstart` do report failures, but the read-back also
// catches a job that launchd accepted and dropped.
export async function startLaunchdJob(
  plist: string,
  run: (cmd: readonly string[], allowFailure?: boolean) => Promise<number>,
  printJob: () => Promise<number>,
): Promise<void> {
  const target = launchdJobTarget();
  // `service stop` (`unload -w`) leaves a disabled override; launchd's bootstrap refuses a disabled job
  // (known launchd behaviour). `load -w` used to clear it.
  await run(['launchctl', 'enable', target]);
  // A loaded job whose process exited (a clean SIGTERM, the wrapper's missing-executable exit) is only
  // restarted by kickstart; an unloaded one is bootstrapped, and RunAtLoad starts it. Without -k,
  // kickstart of an already-running job exits 0 and leaves it untouched (verified on a sandboxed job).
  if ((await printJob()) === 0) await run(['launchctl', 'kickstart', target]);
  else await run(['launchctl', 'bootstrap', launchdDomain(), plist]);
  const code = await printJob();
  if (code !== 0) {
    throw new CliExit(EXIT.transient, m['cli.service.command_failed']({ command: `launchctl print ${target}`, code }));
  }
}

export const BOOTOUT_TIMEOUT_MS = 10_000;

// `bootout` can return while launchd is still tearing the job down ("36: Operation now in progress",
// swallowed by allowFailure). startLaunchdJob would then see the dying job as loaded and kickstart
// the old definition, or bootstrap would fail with "5: Input/output error". Wait until print stops
// finding the job; one still there after the deadline is an error, not something to start over.
export async function bootoutLaunchdJob(
  run: (cmd: readonly string[], allowFailure?: boolean) => Promise<number>,
  printJob: () => Promise<number>,
  timeoutMs: number,
): Promise<void> {
  const target = launchdJobTarget();
  // bootout of a job that is not loaded fails harmlessly.
  await run(['launchctl', 'bootout', target], true);
  const deadline = Date.now() + timeoutMs;
  while ((await printJob()) === 0) {
    if (Date.now() >= deadline) {
      throw new CliExit(
        EXIT.transient,
        m['cli.service.bootout_timeout']({ target, seconds: Math.round(timeoutMs / 1000) }),
      );
    }
    await Bun.sleep(100);
  }
}

export const isDarwinLaunchdJob = (env: NodeJS.ProcessEnv, isTTY: boolean): boolean =>
  isTTY !== true && (env['XPC_SERVICE_NAME'] === LAUNCHD_LABEL || env['AIO_PROXY_MANAGED'] === '1');

export const spawnDarwinRestartHelper = (plist: string, spawn: typeof Bun.spawn): void => {
  const quoted = `'${plist.replaceAll("'", `'\\''`)}'`;
  const script = `sleep 1; /bin/launchctl unload -w ${quoted}; /bin/launchctl load -w ${quoted}`;
  const child = spawn(['/bin/sh', '-c', script], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
  child.unref();
};
