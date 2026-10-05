import { resolveExec } from '../../service/service';

export type UnmanagedRelaunchIo = {
  readonly exec?: string;
  readonly args?: readonly string[];
  readonly argv?: readonly string[];
  readonly helperDelayMs?: number;
  readonly exitDelayMs?: number;
  readonly spawn?: typeof Bun.spawn;
  readonly exit?: (code: number) => void;
  readonly platform?: NodeJS.Platform;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

// Bun compiled binaries keep Node's argv contract: [0] runtime, [1] virtual
// script (`/$bunfs/root/...`), user CLI args from [2]. Replaying [1] makes
// Commander treat the virtual path as a command and the helper dies after
// this process has already scheduled exit.
export const userCliArgs = (argv: readonly string[] = process.argv): readonly string[] => argv.slice(2);

// Dashboard apply runs inside the process being replaced. A managed unit is
// bounced by `runUpgradeCommand`; a foreground `aio-proxy run` has no manager,
// so a detached helper waits for this PID to release the port and execs the
// newly installed launcher with the same user argv. Windows has no `/bin/sh` for that helper, so there it
// throws before spawning or exiting: the caller's failed-relaunch path leaves the restart to the user.
export const scheduleUnmanagedRelaunch = (io: UnmanagedRelaunchIo = {}): void => {
  if ((io.platform ?? process.platform) === 'win32') throw new Error('no unmanaged relaunch helper on Windows');
  const exec = io.exec ?? resolveExec();
  const args = io.args ?? userCliArgs(io.argv);
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
