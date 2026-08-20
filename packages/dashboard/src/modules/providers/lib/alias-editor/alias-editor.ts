import type { AliasConfig, AliasSelectRow, AliasSpeed, ProviderAlias } from '@aio-proxy/types';
import {
  aliasTargetModels,
  flattenAliasVariants,
  normalizeAliasName,
  preservedAliasModels,
  whenIdentity,
} from '@aio-proxy/types';
import { countBy } from 'es-toolkit/array';
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

export const aliasIssueControlId = (issue: AliasEditorIssue): string => {
  const id = aliasControlId(issue.alias, issue.variant);
  return issue.code === 'target-missing' ? `${id}-target` : id;
};

export function serializeAlias(rows: readonly AliasRow[], mode: 'create' | 'edit'): ProviderAlias | undefined {
  return rows.length === 0 && mode === 'create' ? undefined : toAliasRecord(rows);
}

/** Rows are the one internal shape: the legacy record form is exactly the effort-only subset of it. */
export function variantRows(config: AliasConfig): readonly AliasSelectRow[] {
  return flattenAliasVariants(config.variants);
}

const isEffortOnly = (row: AliasSelectRow): boolean =>
  row.when.thinking === undefined && row.when.speed === undefined && (row.when.effort ?? '') !== '';

/**
 * Every config in the wild uses the record form, so emitting rows unconditionally would rewrite a
 * user's whole `alias` block into the verbose shape on the first save of an unrelated field. Effort-only
 * rows round-trip to the compact shape; anything naming thinking or speed needs rows to survive.
 */
export function toAliasVariants(rows: readonly AliasSelectRow[]): AliasConfig['variants'] | undefined {
  if (rows.length === 0) return undefined;
  // A record is keyed on effort, so two rows whose efforts canonicalize alike (`x-high` and `xhigh`)
  // would collapse into one entry and drop a row the user authored. Colliding rows stay an array, which
  // the server's own `rejectDuplicateWhen` refuses out loud instead.
  const collides = new Set(rows.map((row) => whenIdentity(row.when))).size < rows.length;
  if (collides || !rows.every(isEffortOnly)) return [...rows];
  return Object.fromEntries(rows.map((row) => [row.when.effort, { model: row.model, preserve: row.preserve }]));
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
  // the second, and marking one of them makes the other look like the only mistake.
  const nameCounts = countBy(rows, (row) => normalizeAliasName(row.name));

  for (const row of rows) {
    const normalizedAlias = normalizeAliasName(row.name);
    if (normalizedAlias === '') {
      issues.push({ code: 'alias-name-required', alias: row.id });
    } else if ((nameCounts[normalizedAlias] ?? 0) > 1) {
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
