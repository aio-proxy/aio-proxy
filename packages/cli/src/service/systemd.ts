import { homedir } from 'node:os';
import { join } from 'node:path';

import { SYSTEMD_UNIT_NAME } from './unit-templates';

export function systemdUnitPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.config') : xdg;
  return join(base, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}
