import {
  type AliasConfig,
  type AuthoredOAuthAlias,
  INHERIT_OFF_KEY,
  type ProviderAlias,
  flattenAliasVariants,
  normalizeAliasName,
  resolveOAuthAlias,
} from '@aio-proxy/types';

import { type AliasRow, mintAliasRowId } from './alias-editor';

export function isOAuthInheritOff(record: AuthoredOAuthAlias | undefined): boolean {
  if (record === undefined) return false;
  for (const [key, value] of Object.entries(record)) {
    if (!Object.hasOwn(record, key)) continue;
    if (normalizeAliasName(key) === INHERIT_OFF_KEY && value === false) return true;
  }
  return false;
}

export function toOAuthAliasRows(record: AuthoredOAuthAlias | undefined): readonly AliasRow[] {
  if (record === undefined) return [];
  const rows: AliasRow[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (!Object.hasOwn(record, key)) continue;
    const name = normalizeAliasName(key);
    if (name === '' || name === INHERIT_OFF_KEY) continue;
    rows.push({
      id: mintAliasRowId(),
      name,
      origin: value === false ? 'hidden' : 'authored',
      config: value === false ? { model: '', preserve: false } : value,
    });
  }
  return rows;
}

export function mergeInheritedAliasRows(
  authored: readonly AliasRow[],
  defaults: ProviderAlias | undefined,
  exposed: readonly string[],
  inheritOff: boolean,
): readonly AliasRow[] {
  if (inheritOff || defaults === undefined) return authored;
  const taken = new Set(authored.map((row) => normalizeAliasName(row.name)).filter((name) => name !== ''));
  const allowed = new Set(exposed);
  const inherited: AliasRow[] = [];
  for (const [name, config] of Object.entries(defaults)) {
    if (!Object.hasOwn(defaults, name) || taken.has(name)) continue;
    if (!aliasTargetsExposed(config, allowed)) continue;
    inherited.push({ id: mintAliasRowId(), name, origin: 'inherited', config });
  }
  return [...authored, ...inherited];
}

export function serializeOAuthAlias(
  rows: readonly AliasRow[],
  inheritOff: boolean,
  mode: 'create' | 'edit',
): AuthoredOAuthAlias | undefined {
  const record: Record<string, AliasConfig | false> = {};
  for (const row of rows) {
    const name = normalizeAliasName(row.name);
    if (name === '' || name === INHERIT_OFF_KEY || row.origin === 'inherited') continue;
    record[name] = row.origin === 'hidden' ? false : row.config;
  }
  if (inheritOff) record[INHERIT_OFF_KEY] = false;
  if (mode === 'create' && Object.keys(record).length === 0) return undefined;
  return record;
}

export function editorEffectiveAlias(
  rows: readonly AliasRow[],
  defaults: ProviderAlias | undefined,
  exposed: readonly string[],
  inheritOff: boolean,
): ProviderAlias {
  return resolveOAuthAlias(serializeOAuthAlias(rows, inheritOff, 'edit') ?? {}, defaults, exposed);
}

export function hideAliasRow(rows: readonly AliasRow[], id: string): readonly AliasRow[] {
  return rows.map((row) => (row.id === id ? { ...row, origin: 'hidden' } : row));
}

export function restoreAliasRow(rows: readonly AliasRow[], id: string): readonly AliasRow[] {
  return rows.filter((row) => row.id !== id);
}

export function promoteInheritedRow(rows: readonly AliasRow[], id: string): readonly AliasRow[] {
  return rows.map((row) => (row.id === id && row.origin === 'inherited' ? { ...row, origin: 'authored' } : row));
}

/** Persist must promote an inherited row the moment any field changes, or the filter that
 * drops `origin === 'inherited'` throws the edit away (preserve, variants, rename). */
export function promoteEditedInheritedRows(
  next: readonly AliasRow[],
  previous: readonly AliasRow[],
): readonly AliasRow[] {
  const prior = new Map(previous.map((row) => [row.id, row]));
  return next.map((row) => {
    if (row.origin !== 'inherited') return row;
    const before = prior.get(row.id);
    if (before !== undefined && before.name === row.name && before.config === row.config) return row;
    return { ...row, origin: 'authored' };
  });
}

function aliasTargetsExposed(config: AliasConfig, allowed: ReadonlySet<string>): boolean {
  return [config.model, ...flattenAliasVariants(config.variants).map((row) => row.model)].every((model) =>
    allowed.has(model),
  );
}
