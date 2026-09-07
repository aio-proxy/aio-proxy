import { resolveExec } from '../../service/service';

export type UnmanagedRelaunchIo = {
  readonly exec?: string;
  readonly args?: readonly string[];
  readonly helperDelayMs?: number;
  readonly exitDelayMs?: number;
  readonly spawn?: typeof Bun.spawn;
  readonly exit?: (code: number) => void;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

// Dashboard apply runs inside the process being replaced. A managed unit is
// bounced by `runUpgradeCommand`; a foreground `aio-proxy run` has no manager,
// so a detached helper waits for this PID to release the port and execs the
// newly installed launcher with the same argv.
export const scheduleUnmanagedRelaunch = (io: UnmanagedRelaunchIo = {}): void => {
  const exec = io.exec ?? resolveExec();
  const args = io.args ?? process.argv.slice(1);
  const helperDelayMs = io.helperDelayMs ?? 1_000;
  const command = [exec, ...args].map(shellQuote).join(' ');
  const child = (io.spawn ?? Bun.spawn)(['/bin/sh', '-c', `sleep ${helperDelayMs / 1_000}; exec ${command}`], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
  child.unref();
  const exit = io.exit ?? ((code: number) => process.exit(code));
  const exitDelayMs = io.exitDelayMs ?? 100;
  if (exitDelayMs <= 0) {
    exit(0);
    return;
  }
  setTimeout(() => exit(0), exitDelayMs);
};
