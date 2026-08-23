import type { DefaultAliasSelectRow, DefaultAliasSuggestions, ModelCatalog } from '@aio-proxy/plugin-sdk';

import type { AntigravityFamily, Effort } from './collapse';

const EFFORTS = new Set<Effort>(['low', 'medium', 'high']);

export function defaultAntigravityAliases(catalog: ModelCatalog): DefaultAliasSuggestions {
  const available = new Set(catalog.language.map(({ id }) => id));
  const aliases: Record<string, DefaultAliasSuggestions[string]> = {};

  for (const family of readAntigravityFamilies(catalog.metadata)) {
    if (!familyTargetsAvailable(family, available)) continue;
    const variants: DefaultAliasSelectRow[] = family.variants
      .filter((variant) => EFFORTS.has(variant.effort))
      .map((variant) => ({
        when: { effort: variant.effort },
        model: variant.model,
        preserve: false,
      }));
    const high = variants.find((variant) => variant.when.effort === 'high');
    if (high !== undefined) {
      variants.push({ when: { effort: 'xhigh' }, model: high.model, preserve: false });
    }
    for (const id of family.suppressedWireIds ?? []) {
      if (!available.has(id)) continue;
      variants.push({ when: { effort: `hidden:${id}` }, model: id, preserve: false });
    }
    if (isSelfReferentialEmptyWhen(family.logicalId, family.base, variants)) continue;
    aliases[family.logicalId] = {
      model: family.base,
      preserve: false,
      ...(variants.length === 0 ? {} : { variants }),
    };
  }

  return aliases;
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

function readAntigravityFamilies(metadata: unknown): readonly AntigravityFamily[] {
  if (!isRecord(metadata) || !Array.isArray(metadata['antigravityFamilies'])) return [];
  const families: AntigravityFamily[] = [];
  for (const value of metadata['antigravityFamilies']) {
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
