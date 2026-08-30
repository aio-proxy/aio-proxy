import type { DefaultAliasSelectRow, DefaultAliasSuggestions, ModelCatalog } from '@aio-proxy/plugin-sdk';
import { isRecord } from '@aio-proxy/types';

import { isEmptyWhen, peelSlug, whenIdentity } from './peel';
import { pickDefaultModel, type PeeledVariant } from './pick-default';
import { rewriteAliasKey } from './rewrite';

type CursorAliasOverride = {
  readonly pinDefault?: string;
  readonly skip?: boolean;
};

// Reserved escape hatch keyed by AvailableModel.name. Intentionally empty: every
// production family is expected to fall out of the generic peel/pick rules.
const CURSOR_ALIAS_OVERRIDES: Readonly<Record<string, CursorAliasOverride>> = {};

type CursorFamily = {
  readonly name: string;
  readonly variants: readonly { readonly slug: string; readonly isDefaultNonMax?: boolean }[];
};

export function defaultCursorAliases(catalog: ModelCatalog): DefaultAliasSuggestions {
  const usable = new Set(catalog.language.map(({ id }) => id));
  const out: Record<string, DefaultAliasSuggestions[string]> = {};
  for (const family of readCursorFamilies(catalog.extra)) {
    const override = CURSOR_ALIAS_OVERRIDES[family.name];
    if (override?.skip === true) continue;
    const rows = peelFamily(family, usable);
    if (rows.length === 0) continue;
    const key = rewriteAliasKey(family.name);
    if (key.length === 0 || out[key] !== undefined) continue;
    const chosen = pickDefaultModel(family.name, rows, override?.pinDefault);
    // A lone bare slug whose alias key is the slug itself would only alias a
    // model to itself.
    if (rows.length === 1 && key === rows[0]!.slug && isEmptyWhen(rows[0]!.when)) continue;
    // Dedupe before dropping the default so a when-collision resolves in favour
    // of the default, which the base `model` already covers.
    const variants = dedupeWhen(
      rows.filter((row) => !isEmptyWhen(row.when)),
      chosen,
    )
      .filter((row) => row.slug !== chosen)
      .map((row) => ({ when: row.when, model: row.slug, preserve: false }) satisfies DefaultAliasSelectRow);
    out[key] = {
      model: chosen,
      preserve: false,
      ...(variants.length === 0 ? {} : { variants }),
    };
  }
  if (usable.has('default') && out['auto'] === undefined) out['auto'] = { model: 'default', preserve: false };
  return out;
}

function peelFamily(family: CursorFamily, usable: ReadonlySet<string>): readonly PeeledVariant[] {
  const rows: PeeledVariant[] = [];
  for (const variant of family.variants) {
    if (!usable.has(variant.slug)) continue;
    // The family's own slug carries no axes even when it ends in a token the
    // peeler would strip (`grok-code-fast`).
    if (variant.slug === family.name) {
      rows.push({ ...variant, when: {} });
      continue;
    }
    const peeled = peelSlug(variant.slug);
    if (peeled === undefined) continue;
    rows.push({ ...variant, when: peeled.when });
  }
  return rows;
}

// AliasConfigSchema rejects two rows sharing a `when`, so collisions must be
// resolved here or the first login would throw.
function dedupeWhen(rows: readonly PeeledVariant[], preferred: string): readonly PeeledVariant[] {
  const byWhen = new Map<string, PeeledVariant>();
  for (const row of rows) {
    const identity = whenIdentity(row.when);
    const existing = byWhen.get(identity);
    if (existing === undefined || wins(row, existing, preferred)) byWhen.set(identity, row);
  }
  return [...byWhen.values()];
}

function wins(candidate: PeeledVariant, incumbent: PeeledVariant, preferred: string): boolean {
  if (candidate.slug === preferred) return true;
  if (incumbent.slug === preferred) return false;
  return candidate.slug.localeCompare(incumbent.slug) < 0;
}

function readCursorFamilies(extra: unknown): readonly CursorFamily[] {
  if (!isRecord(extra)) return [];
  const families = extra['cursorFamilies'];
  if (!Array.isArray(families)) return [];
  const parsed: CursorFamily[] = [];
  for (const family of families) {
    if (!isRecord(family)) continue;
    const name = family['name'];
    const variants = family['variants'];
    if (typeof name !== 'string' || !Array.isArray(variants)) continue;
    parsed.push({ name, variants: variants.flatMap(readVariant) });
  }
  return parsed;
}

function readVariant(value: unknown): CursorFamily['variants'][number][] {
  if (!isRecord(value)) return [];
  const slug = value['slug'];
  if (typeof slug !== 'string') return [];
  return [{ slug, ...(value['isDefaultNonMax'] === true ? { isDefaultNonMax: true } : {}) }];
}
