import type { DefaultAliasSelectRow, DefaultAliasSuggestions, ModelCatalog } from '@aio-proxy/plugin-sdk';

import type { AntigravityFamily, Effort } from './collapse';

const EFFORTS = new Set<Effort>(['low', 'medium', 'high']);

export function defaultAntigravityAliases(catalog: ModelCatalog): DefaultAliasSuggestions {
  const available = new Set(catalog.language.map(({ id }) => id));
  const aliases: Record<string, DefaultAliasSuggestions[string]> = {};

  for (const family of familiesForAliases(catalog)) {
    if (!familyTargetsAvailable(family, available)) continue;
    const effortRows = family.variants
      .filter((variant) => EFFORTS.has(variant.effort))
      .map((variant) => ({
        when: { effort: variant.effort },
        model: variant.model,
        preserve: false,
      }));
    const high = effortRows.find((row) => row.when.effort === 'high');
    const catalogTiered = `${family.logicalId}-tiered`;
    const tiered =
      (family.suppressedWireIds ?? []).find((id) => id.endsWith('-tiered') && available.has(id)) ??
      (available.has(catalogTiered) ? catalogTiered : undefined);
    const defaultModel = tiered ?? family.base;
    const variants: DefaultAliasSelectRow[] = routesByEffort(defaultModel, effortRows)
      ? [...effortRows, ...xhighRow(tiered ?? high?.model)]
      : [];
    const claimed = new Set([defaultModel, ...variants.map((row) => row.model)]);
    for (const id of family.suppressedWireIds ?? []) {
      if (!available.has(id) || claimed.has(id)) continue;
      variants.push({
        when: id.endsWith('-thinking') ? { thinking: true } : { effort: `hidden:${id}` },
        model: id,
        preserve: false,
      });
      claimed.add(id);
    }
    if (isSelfReferentialEmptyWhen(family.logicalId, defaultModel, variants)) continue;
    aliases[family.logicalId] = {
      model: defaultModel,
      preserve: false,
      ...(variants.length === 0 ? {} : { variants }),
    };
  }

  return aliases;
}

function routesByEffort(base: string, rows: readonly DefaultAliasSelectRow[]): boolean {
  const models = new Set(rows.map((row) => row.model));
  return models.size > 1 || (models.size === 1 && !models.has(base));
}

function xhighRow(model: string | undefined): DefaultAliasSelectRow[] {
  return model === undefined ? [] : [{ when: { effort: 'xhigh' }, model, preserve: false }];
}

function familiesForAliases(catalog: ModelCatalog): readonly AntigravityFamily[] {
  const stored = readAntigravityFamilies(catalog.extra);
  const leftover = leftoverThinkingFamilies(catalog, stored);
  return leftover.length === 0 ? stored : [...stored, ...leftover];
}

function leftoverThinkingFamilies(
  catalog: ModelCatalog,
  stored: readonly AntigravityFamily[],
): readonly AntigravityFamily[] {
  const claimed = new Set<string>();
  const leftover: AntigravityFamily[] = stored.map((family) => withThinkingSibling(family, catalog, claimed));
  for (const { id } of catalog.language) {
    if (!id.endsWith('-thinking')) continue;
    const stem = id.slice(0, -'-thinking'.length);
    if (!availableHas(catalog, stem) || claimed.has(stem) || claimed.has(id)) continue;
    leftover.push({
      logicalId: stem,
      kind: 'same-wire',
      thinking: { mode: 'gemini' },
      base: stem,
      variants: [],
      suppressedWireIds: [id],
    });
    claimed.add(stem);
    claimed.add(id);
  }
  return leftover;
}

function withThinkingSibling(
  family: AntigravityFamily,
  catalog: ModelCatalog,
  claimed: Set<string>,
): AntigravityFamily {
  const thinkingId = `${family.logicalId}-thinking`;
  const existing = new Set([
    family.base,
    ...family.variants.map((row) => row.model),
    ...(family.suppressedWireIds ?? []),
  ]);
  for (const id of existing) claimed.add(id);
  claimed.add(family.logicalId);
  if (!availableHas(catalog, thinkingId) || existing.has(thinkingId) || claimed.has(thinkingId)) return family;
  claimed.add(thinkingId);
  return { ...family, suppressedWireIds: [...(family.suppressedWireIds ?? []), thinkingId] };
}

function availableHas(catalog: ModelCatalog, id: string): boolean {
  return catalog.language.some((model) => model.id === id);
}

function familyTargetsAvailable(family: AntigravityFamily, available: ReadonlySet<string>): boolean {
  if (!available.has(family.base)) return false;
  return family.variants.every((variant) => available.has(variant.model));
}

function isSelfReferentialEmptyWhen(
  logicalId: string,
  base: string,
  variants: readonly DefaultAliasSelectRow[],
): boolean {
  if (variants.length === 0) return logicalId === base;
  return variants.length === 1 && logicalId === variants[0]!.model && isEmptyWhen(variants[0]!.when);
}

function isEmptyWhen(when: DefaultAliasSelectRow['when']): boolean {
  return when.thinking === undefined && when.effort === undefined && when.speed === undefined;
}

function readAntigravityFamilies(extra: unknown): readonly AntigravityFamily[] {
  if (!isRecord(extra) || !Array.isArray(extra['antigravityFamilies'])) return [];
  const families: AntigravityFamily[] = [];
  for (const value of extra['antigravityFamilies']) {
    const family = asFamily(value);
    if (family !== undefined) families.push(family);
  }
  return families;
}

function asFamily(value: unknown): AntigravityFamily | undefined {
  if (!isRecord(value)) return undefined;
  const logicalId = asString(value['logicalId']);
  const base = asString(value['base']);
  const kind = value['kind'];
  const thinking = value['thinking'];
  const thinkingMode = isRecord(thinking) ? thinking['mode'] : undefined;
  if (logicalId === undefined || base === undefined) return undefined;
  if (kind !== 'split' && kind !== 'tiered' && kind !== 'same-wire') return undefined;
  if (thinkingMode !== 'gemini' && thinkingMode !== 'claude' && thinkingMode !== 'none') return undefined;
  if (!Array.isArray(value['variants'])) return undefined;
  const variants: { effort: Effort; model: string }[] = [];
  for (const row of value['variants']) {
    if (!isRecord(row)) continue;
    const effort = row['effort'];
    const model = asString(row['model']);
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') continue;
    if (model === undefined) continue;
    variants.push({ effort, model });
  }
  const suppressedWireIds = Array.isArray(value['suppressedWireIds'])
    ? value['suppressedWireIds'].filter((id): id is string => typeof id === 'string' && id !== '')
    : [];
  return {
    logicalId,
    kind,
    thinking: { mode: thinkingMode },
    base,
    variants,
    ...(suppressedWireIds.length === 0 ? {} : { suppressedWireIds }),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
