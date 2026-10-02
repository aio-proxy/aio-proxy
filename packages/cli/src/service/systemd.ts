import { homedir } from 'node:os';
import { join } from 'node:path';

import { SYSTEMD_UNIT_NAME } from './unit-templates';

export function systemdUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.config') : xdg;
  return join(base, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}
