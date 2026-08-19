import type { AliasConfig, AliasSelectRow, AliasSpeed, ProviderAlias } from '@aio-proxy/types';
import {
  aliasTargetModels,
  flattenAliasVariants,
  normalizeAliasName,
  preservedAliasModels,
  whenIdentity,
} from '@aio-proxy/types';
import type { ReactFormExtendedApi } from '@tanstack/react-form';

export type { ProviderAlias };

export type AliasDraft = {
  readonly name: string;
  readonly model: string;
  readonly preserve: boolean;
};

export type AliasDraftForm = ReactFormExtendedApi<AliasDraft, any, any, any, any, any, any, any, any, any, any, any>;

export type AliasEditResult =
  | { readonly ok: true; readonly alias: ProviderAlias }
  | { readonly ok: false; readonly code: 'alias-missing' | 'name-duplicate' | 'name-required' | 'target-required' };

export type AliasEditorIssue = {
  readonly code:
    | 'alias-name-duplicate'
    | 'alias-name-required'
    | 'preserved-route-conflict'
    | 'target-missing'
    | 'variant-effort-blank'
    | 'variant-when-duplicate'
    | 'variant-when-required';
  readonly alias: string;
  /** Index into the alias's stored variant rows. Rows carry a condition, not a name, so there is no key. */
  readonly variant?: number;
};

export type AliasSummary = {
  readonly aliases: number;
  readonly variants: number;
};

export const aliasControlId = (alias: string, variant?: number): string =>
  variant === undefined
    ? `provider-alias-${encodeURIComponent(alias)}`
    : `provider-alias-${encodeURIComponent(alias)}-variant-${variant}`;

export const aliasIssueControlId = (issue: AliasEditorIssue): string => {
  const id = aliasControlId(issue.alias, issue.variant);
  return issue.code === 'target-missing' ? `${id}-target` : id;
};

export function serializeAlias(alias: ProviderAlias, mode: 'create' | 'edit'): ProviderAlias | undefined {
  return Object.keys(alias).length === 0 && mode === 'create' ? undefined : alias;
}

export function commitAliasDraft(alias: ProviderAlias, draft: AliasDraft): AliasEditResult {
  const name = normalizeAliasName(draft.name);
  const error = draftError(name, draft.model, Object.keys(alias).map(normalizeAliasName));
  if (error !== undefined) {
    return { ok: false, code: error };
  }

  return {
    ok: true,
    alias: { ...alias, [name]: { model: draft.model, preserve: draft.preserve } },
  };
}

export function renameAlias(alias: ProviderAlias, current: string, next: string): AliasEditResult {
  const config = alias[current];
  if (config === undefined) {
    return { ok: false, code: 'alias-missing' };
  }

  const name = normalizeAliasName(next);
  const otherNames = Object.keys(alias)
    .filter((key) => key !== current)
    .map(normalizeAliasName);
  const error = draftError(name, config.model, otherNames);
  if (error !== undefined) {
    return { ok: false, code: error };
  }

  const renamed = Object.fromEntries(
    Object.entries(alias).map(([key, value]) => [key === current ? name : key, value]),
  );
  return { ok: true, alias: renamed };
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

export function withVariantRows(
  alias: ProviderAlias,
  aliasName: string,
  rows: readonly AliasSelectRow[],
): ProviderAlias {
  const config = alias[aliasName];
  if (config === undefined) return alias;
  const variants = toAliasVariants(rows);
  const next: AliasConfig =
    variants === undefined
      ? { model: config.model, preserve: config.preserve }
      : { model: config.model, preserve: config.preserve, variants };
  return { ...alias, [aliasName]: next };
}

export function addVariantRow(alias: ProviderAlias, aliasName: string, row: AliasSelectRow): ProviderAlias {
  const config = alias[aliasName];
  if (config === undefined) return alias;
  return withVariantRows(alias, aliasName, [...variantRows(config), row]);
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

export function aliasSummary(alias: ProviderAlias): AliasSummary {
  let variants = 0;
  for (const config of Object.values(alias)) {
    variants += flattenAliasVariants(config.variants).length;
  }
  return { aliases: Object.keys(alias).length, variants };
}

export function preserveReferenceCount(alias: ProviderAlias, model: string): number {
  let count = 0;
  for (const config of Object.values(alias)) {
    if (config.preserve && config.model === model) {
      count += 1;
    }
    for (const row of flattenAliasVariants(config.variants)) {
      if (row.preserve && row.model === model) {
        count += 1;
      }
    }
  }
  return count;
}

export function aliasEditorIssues(alias: ProviderAlias, models?: readonly string[]): readonly AliasEditorIssue[] {
  const issues: AliasEditorIssue[] = [];
  // Keep in lockstep with validateAliasTargets in @aio-proxy/types: absent and
  // empty both mean "no whitelist", or the editor blocks a payload the server accepts.
  const availableModels = models === undefined || models.length === 0 ? undefined : new Set(models);
  const preservedModels = preservedAliasModels(alias);
  const aliasNames = new Set<string>();

  for (const [aliasName, config] of Object.entries(alias)) {
    const normalizedAlias = normalizeAliasName(aliasName);
    if (normalizedAlias === '') {
      issues.push({ code: 'alias-name-required', alias: aliasName });
    } else if (aliasNames.has(normalizedAlias)) {
      issues.push({ code: 'alias-name-duplicate', alias: aliasName });
    }
    aliasNames.add(normalizedAlias);

    if (preservedModels.has(normalizedAlias) && aliasTargetModels(config).some((model) => model !== normalizedAlias)) {
      issues.push({ code: 'preserved-route-conflict', alias: aliasName });
    }
    if (availableModels !== undefined && !availableModels.has(config.model)) {
      issues.push({ code: 'target-missing', alias: aliasName });
    }

    const conditions = new Set<string>();
    for (const [variant, row] of variantRows(config).entries()) {
      // An empty identity means no dimension at all. A present-but-blank effort still has an identity
      // (`effort=`), so it needs its own check: the schema takes it, no request can ever match it.
      const identity = whenIdentity(row.when);
      if (identity === '') {
        issues.push({ code: 'variant-when-required', alias: aliasName, variant });
      } else if (row.when.effort === '') {
        issues.push({ code: 'variant-effort-blank', alias: aliasName, variant });
      } else if (conditions.has(identity)) {
        issues.push({ code: 'variant-when-duplicate', alias: aliasName, variant });
      }
      conditions.add(identity);
      if (availableModels !== undefined && !availableModels.has(row.model)) {
        issues.push({ code: 'target-missing', alias: aliasName, variant });
      }
    }
  }

  return issues;
}

function draftError(
  name: string,
  model: string,
  existingNames: readonly string[],
): Extract<AliasEditResult, { readonly ok: false }>['code'] | undefined {
  if (name === '') {
    return 'name-required';
  }
  if (model === '') {
    return 'target-required';
  }
  return existingNames.includes(name) ? 'name-duplicate' : undefined;
}
