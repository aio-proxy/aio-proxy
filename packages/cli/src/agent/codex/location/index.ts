import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

import type { CodexLocation } from '../contracts';

const expandHome = (value: string, home: string): string => {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value;
};

const resolveStoragePath = (value: string, base: string, userHome: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || [...trimmed].some((character) => character.codePointAt(0)! <= 0x1f)) return undefined;
  if (trimmed.startsWith('~') && trimmed !== '~' && !trimmed.startsWith('~/')) return undefined;
  const expanded = expandHome(trimmed, userHome);
  if (isAbsolute(expanded)) return normalize(expanded);
  const resolved = normalize(resolve(base, expanded));
  return resolved === base || resolved.startsWith(`${base}/`) ? resolved : undefined;
};

const readConfiguredSqliteHome = (configPath: string, codexHome: string, userHome: string): string | undefined => {
  try {
    const stat = lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const parsed: unknown = Bun.TOML.parse(readFileSync(configPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const value = (parsed as { sqlite_home?: unknown }).sqlite_home;
    return typeof value === 'string' ? resolveStoragePath(value, codexHome, userHome) : undefined;
  } catch {
    return undefined;
  }
};

/** Resolve the global Codex home without making a relative CODEX_HOME cwd-relative. */
export function resolveCodexLocation(home: string, env: Readonly<Record<string, string | undefined>>): CodexLocation {
  const userHome = env['HOME']?.trim() || homedir();
  const configured = env['CODEX_HOME']?.trim();
  const candidate = configured
    ? expandHome(configured, userHome)
    : expandHome(home.trim(), userHome) || join(userHome, '.codex');
  const actualHome = normalize(isAbsolute(candidate) ? candidate : resolve(userHome, candidate));
  const explicitSqliteHome = env['CODEX_SQLITE_HOME']?.trim();
  const useConfigSqliteHome = explicitSqliteHome === undefined || explicitSqliteHome.length === 0;
  const sqliteHome = useConfigSqliteHome
    ? readConfiguredSqliteHome(join(actualHome, 'config.toml'), actualHome, userHome)
    : resolveStoragePath(explicitSqliteHome, userHome, userHome);
  const managedRoot = join(actualHome, '.aio-proxy');
  return {
    home: actualHome,
    configPath: join(actualHome, 'config.toml'),
    managedRoot,
    markerPath: join(managedRoot, 'codex-config.json'),
    sqliteHome,
    legacyScanAllowed: env['CODEX_LEGACY_SCAN_ALLOWED'] === '1' || (useConfigSqliteHome && sqliteHome !== undefined),
  };
}
