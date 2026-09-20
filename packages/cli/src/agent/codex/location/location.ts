import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

import { isPlainObject } from 'es-toolkit/predicate';

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

const readConfiguredSqliteHome = (
  configPath: string,
  codexHome: string,
  userHome: string,
): { readonly present: false } | { readonly present: true; readonly value?: string } => {
  try {
    const stat = lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { present: false };
    const parsed: unknown = Bun.TOML.parse(readFileSync(configPath, 'utf8'));
    if (!isPlainObject(parsed)) return { present: false };
    const value = (parsed as { sqlite_home?: unknown }).sqlite_home;
    if (!Object.hasOwn(parsed, 'sqlite_home')) return { present: false };
    if (typeof value !== 'string') return { present: true };
    return { present: true, value: resolveStoragePath(value, codexHome, userHome) };
  } catch {
    return { present: false };
  }
};

/**
 * Resolve the SQLite root and whether config.toml is what redirected it. Both answers come from the
 * same branch on purpose: deciding them in separate expressions guarded by one shared boolean hides
 * the correlation, so nothing stops a later edit from reading the config result on the explicit path.
 */
const resolveSqliteHome = (
  explicit: string | undefined,
  codexHome: string,
  userHome: string,
): { readonly sqliteHome: string | undefined; readonly redirectedByConfig: boolean } => {
  if (explicit !== undefined && explicit.length > 0)
    return { sqliteHome: resolveStoragePath(explicit, userHome, userHome), redirectedByConfig: false };
  const configured = readConfiguredSqliteHome(join(codexHome, 'config.toml'), codexHome, userHome);
  if (!configured.present) return { sqliteHome: codexHome, redirectedByConfig: false };
  return { sqliteHome: configured.value, redirectedByConfig: configured.value !== undefined };
};

/** Resolve the global Codex home without making a relative CODEX_HOME cwd-relative. */
export function resolveCodexLocation(home: string, env: Readonly<Record<string, string | undefined>>): CodexLocation {
  const userHome = env['HOME']?.trim() || homedir();
  const configured = env['CODEX_HOME']?.trim();
  const candidate = configured
    ? expandHome(configured, userHome)
    : expandHome(home.trim(), userHome) || join(userHome, '.codex');
  const actualHome = normalize(isAbsolute(candidate) ? candidate : resolve(userHome, candidate));
  const { sqliteHome, redirectedByConfig } = resolveSqliteHome(env['CODEX_SQLITE_HOME']?.trim(), actualHome, userHome);
  const managedRoot = join(actualHome, '.aio-proxy');
  return {
    home: actualHome,
    configPath: join(actualHome, 'config.toml'),
    managedRoot,
    markerPath: join(managedRoot, 'codex-config.json'),
    sqliteHome,
    legacyScanAllowed: env['CODEX_LEGACY_SCAN_ALLOWED'] === '1' || redirectedByConfig,
  };
}
