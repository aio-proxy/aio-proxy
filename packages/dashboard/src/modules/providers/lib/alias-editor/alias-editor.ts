import type { AliasConfig, AliasSelectRow, AliasSpeed, ProviderAlias } from '@aio-proxy/types';
import {
  aliasTargetModels,
  flattenAliasVariants,
  normalizeAliasName,
  preservedAliasModels,
  whenIdentity,
} from '@aio-proxy/types';
import { omit } from 'es-toolkit/object';

export type { ProviderAlias };

export type AliasRow = {
  readonly id: string;
  readonly name: string;
  readonly config: AliasConfig;
};

export type AliasEditorIssue = {
  readonly code:
    | 'alias-name-duplicate'
    | 'alias-name-required'
    | 'preserved-route-conflict'
    | 'target-missing'
    | 'variant-when-duplicate'
    | 'variant-when-required';
  /** Stable row id, not the alias name — two rows may legally share a name while editing. */
  readonly alias: string;
  /** Index into the alias's stored variant rows. Rows carry a condition, not a name, so there is no key. */
  readonly variant?: number;
};

export type AliasSummary = {
  readonly aliases: number;
  readonly variants: number;
};

let sequence = 0;
const nextKey = (): string => {
  sequence += 1;
  return `k${sequence}`;
};

export const blankAliasRow = (model: string): AliasRow => ({
  id: nextKey(),
  name: '',
  config: { model, preserve: false },
});

export function toAliasRows(record: ProviderAlias): readonly AliasRow[] {
  return Object.entries(record).map(([name, config]) => ({
    id: nextKey(),
    name,
    config,
  }));
}

export function toAliasRecord(rows: readonly AliasRow[]): ProviderAlias {
  return Object.fromEntries(
    rows.map((row) => [normalizeAliasName(row.name), row.config] as const).filter(([name]) => name !== ''),
  );
}

export const aliasControlId = (rowId: string, variant?: number): string =>
  variant === undefined
    ? `provider-alias-${encodeURIComponent(rowId)}`
    : `provider-alias-${encodeURIComponent(rowId)}-variant-${variant}`;

export function serializeAlias(rows: readonly AliasRow[], mode: 'create' | 'edit'): ProviderAlias | undefined {
  return rows.length === 0 && mode === 'create' ? undefined : toAliasRecord(rows);
}

/** Rows are the one internal shape: the legacy record form is exactly the effort-only subset of it. */
export function variantRows(config: AliasConfig): readonly AliasSelectRow[] {
  return flattenAliasVariants(config.variants);
}

export function toAliasVariants(rows: readonly AliasSelectRow[]): AliasConfig['variants'] | undefined {
  return rows.length === 0 ? undefined : [...rows];
}

const configWithVariantRows = (config: AliasConfig, rows: readonly AliasSelectRow[]): AliasConfig => {
  const variants = toAliasVariants(rows);
  return variants === undefined
    ? { model: config.model, preserve: config.preserve }
    : { model: config.model, preserve: config.preserve, variants };
};

export function withVariantRows(
  aliases: readonly AliasRow[],
  id: string,
  rows: readonly AliasSelectRow[],
): readonly AliasRow[] {
  return aliases.map((row) => (row.id === id ? { ...row, config: configWithVariantRows(row.config, rows) } : row));
}

export function addVariantRow(aliases: readonly AliasRow[], id: string, row: AliasSelectRow): readonly AliasRow[] {
  const target = aliases.find((item) => item.id === id);
  if (target === undefined) return aliases;
  return withVariantRows(aliases, id, [...variantRows(target.config), row]);
}

/** An unconditioned row: it reports `variant-when-required` on sight, which is what blocks the save
 * until the user names a dimension. Appending it beats a staged draft that would duplicate this editor. */
export const blankVariantRow = (model: string): AliasSelectRow => ({ when: {}, model, preserve: false });

/** Selects need a value for "not part of this condition"; `undefined` is not one. */
export const ANY_DIMENSION = 'any';

export type AliasRowDraft = {
  readonly thinking: typeof ANY_DIMENSION | 'on' | 'off';
  readonly effort: string;
  readonly speed: typeof ANY_DIMENSION | AliasSpeed;
  readonly model: string;
  readonly preserve: boolean;
};

export const toRowDraft = (row: AliasSelectRow): AliasRowDraft => ({
  thinking: row.when.thinking === undefined ? ANY_DIMENSION : row.when.thinking ? 'on' : 'off',
  effort: row.when.effort ?? '',
  speed: row.when.speed ?? ANY_DIMENSION,
  model: row.model,
  preserve: row.preserve,
});

/** Blank effort drops the key rather than storing `''`: an empty condition is at least reported as
 * `variant-when-required`, where `effort: ''` is a condition no request can ever match. */
export const fromRowDraft = (draft: AliasRowDraft): AliasSelectRow => ({
  when: {
    ...(draft.thinking === ANY_DIMENSION ? {} : { thinking: draft.thinking === 'on' }),
    ...(draft.effort.trim() === '' ? {} : { effort: draft.effort }),
    ...(draft.speed === ANY_DIMENSION ? {} : { speed: draft.speed }),
  },
  model: draft.model,
  preserve: draft.preserve,
});

export function aliasSummary(rows: readonly AliasRow[]): AliasSummary {
  let variants = 0;
  for (const row of rows) {
    variants += flattenAliasVariants(row.config.variants).length;
  }
  return { aliases: rows.length, variants };
}

export function aliasEditorIssues(rows: readonly AliasRow[], models?: readonly string[]): readonly AliasEditorIssue[] {
  const issues: AliasEditorIssue[] = [];
  // Keep in lockstep with validateAliasTargets in @aio-proxy/types: absent and
  // empty both mean "no whitelist", or the editor blocks a payload the server accepts.
  const availableModels = models === undefined || models.length === 0 ? undefined : new Set(models);
  const preservedModels = preservedAliasModels(toAliasRecord(rows));
  // Every row in a collision is flagged, not just the later one: the first row is no more legal than
  // the second, and marking one of them makes the other look like the only mistake. A `Map`, not a
  // counted record: the names are user-typed, and a plain object answers `constructor` (or `toString`,
  // `valueOf`, `__proto__`) from the prototype, so two rows named `constructor` counted as one, raised
  // no duplicate issue, and saved as a single alias — silent data loss.
  const nameCounts = new Map<string, number>();
  for (const row of rows) {
    const name = normalizeAliasName(row.name);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  for (const row of rows) {
    const normalizedAlias = normalizeAliasName(row.name);
    if (normalizedAlias === '') {
      issues.push({ code: 'alias-name-required', alias: row.id });
    } else if ((nameCounts.get(normalizedAlias) ?? 0) > 1) {
      issues.push({ code: 'alias-name-duplicate', alias: row.id });
    }

    if (
      preservedModels.has(normalizedAlias) &&
      aliasTargetModels(row.config).some((model) => model !== normalizedAlias)
    ) {
      issues.push({ code: 'preserved-route-conflict', alias: row.id });
    }
    if (availableModels !== undefined && !availableModels.has(row.config.model)) {
      issues.push({ code: 'target-missing', alias: row.id });
    }

    const conditions = new Set<string>();
    for (const [variant, variantRow] of variantRows(row.config).entries()) {
      // A blank effort is not a dimension, but the server's `whenIdentity` still emits `effort=` for it,
      // which would read as a condition. Drop it first so `{ effort: '' }` reports the same missing
      // condition as `{}` — the state the user has to fix is the same one.
      const when = variantRow.when.effort?.trim() === '' ? omit(variantRow.when, ['effort']) : variantRow.when;
      const identity = whenIdentity(when);
      if (identity === '') {
        issues.push({ code: 'variant-when-required', alias: row.id, variant });
      } else if (conditions.has(identity)) {
        issues.push({ code: 'variant-when-duplicate', alias: row.id, variant });
      }
      conditions.add(identity);
      if (availableModels !== undefined && !availableModels.has(variantRow.model)) {
        issues.push({ code: 'target-missing', alias: row.id, variant });
      }
    }
  }

  return issues;
}
