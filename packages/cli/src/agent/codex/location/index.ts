import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

import type { CodexLocation } from '../contracts';

const expandHome = (value: string, home: string): string => {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value;
};

/** Resolve the global Codex home without making a relative CODEX_HOME cwd-relative. */
export function resolveCodexLocation(home: string, env: Readonly<Record<string, string | undefined>>): CodexLocation {
  const userHome = env['HOME']?.trim() || homedir();
  const configured = env['CODEX_HOME']?.trim();
  const candidate = configured
    ? expandHome(configured, userHome)
    : expandHome(home.trim(), userHome) || join(userHome, '.codex');
  const actualHome = normalize(isAbsolute(candidate) ? candidate : resolve(userHome, candidate));
  const managedRoot = join(actualHome, '.aio-proxy');
  return {
    home: actualHome,
    configPath: join(actualHome, 'config.toml'),
    managedRoot,
    markerPath: join(managedRoot, 'codex-config.json'),
  };
}
