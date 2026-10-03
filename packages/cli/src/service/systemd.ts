import { homedir } from 'node:os';
import { join } from 'node:path';

import { SYSTEMD_UNIT_NAME } from './unit-templates';

/** Why `systemctl --user` cannot manage a unit here, or `null` when a user manager answers. */
export type SystemdUserProblem = 'systemctl_missing' | 'systemd_user_unavailable' | null;

// Containers and WSL without systemd as PID 1 lack the binary or the user bus; probing first keeps an
// install from writing a unit nothing will ever run.
export async function systemdUserProblem(): Promise<SystemdUserProblem> {
  if (Bun.which('systemctl') === null) return 'systemctl_missing';
  const probe = Bun.spawn(['systemctl', '--user', 'show-environment'], { stdout: 'ignore', stderr: 'ignore' });
  return (await probe.exited) === 0 ? null : 'systemd_user_unavailable';
}

export function systemdUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.config') : xdg;
  return join(base, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

// Undoes `systemdQuote` (unit-templates): `\\`, `\"` and `%%` back to the literal character.
const unquote = (quoted: string): string =>
  quoted.slice(1, -1).replace(/\\([\\"])|%%/g, (_, escaped: string | undefined) => escaped ?? '%');

/** The pieces of a unit written by `renderSystemdUnit`: its ExecStart program and every `Environment="K=V"` line. */
export function parseSystemdUnit(text: string): { exec: string | null; env: Record<string, string> } {
  const exec = /^ExecStart=("(?:[^"\\]|\\.)*")/m.exec(text)?.[1];
  const env: Record<string, string> = {};
  for (const [, quoted] of text.matchAll(/^Environment=("(?:[^"\\]|\\.)*")\s*$/gm)) {
    const pair = unquote(quoted!);
    const eq = pair.indexOf('=');
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { exec: exec === undefined ? null : unquote(exec), env };
}
