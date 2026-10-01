import { getLocale, m } from '@aio-proxy/i18n';
import { isPlainObject } from 'es-toolkit/predicate';

import { formatCompactTokenCount } from '@/components/token-count';

/** The `ModelMetadataSchema` fields the form reaches. Anything else stays reachable through JSON. */
export const LIMIT_KEYS = ['context', 'input', 'output'] as const;
export const CAPABILITY_KEYS = ['toolCall', 'reasoning', 'attachment', 'structuredOutput', 'temperature'] as const;
export const PRICE_MAIN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;
export const PRICE_MORE_KEYS = ['inputAudio', 'outputAudio', 'image', 'webSearch', 'request'] as const;
export const TIER_PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

export type LimitKey = (typeof LIMIT_KEYS)[number];
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type PriceKey = (typeof PRICE_MAIN_KEYS)[number] | (typeof PRICE_MORE_KEYS)[number];

export const LIMIT_LABEL: Readonly<Record<LimitKey, () => string>> = {
  context: m['dashboard.routing.editor.metadata_limit_label_context'],
  input: m['dashboard.routing.editor.metadata_limit_label_input'],
  output: m['dashboard.routing.editor.metadata_limit_label_output'],
};

export const CAPABILITY_LABEL: Readonly<Record<CapabilityKey, () => string>> = {
  toolCall: m['dashboard.routing.editor.metadata_capability_label_tool_call'],
  reasoning: m['dashboard.routing.editor.metadata_capability_label_reasoning'],
  attachment: m['dashboard.routing.editor.metadata_capability_label_attachment'],
  structuredOutput: m['dashboard.routing.editor.metadata_capability_label_structured_output'],
  temperature: m['dashboard.routing.editor.metadata_capability_label_temperature'],
};

export const PRICE_LABEL: Readonly<Record<PriceKey, () => string>> = {
  input: m['dashboard.routing.editor.metadata_cost_label_input'],
  output: m['dashboard.routing.editor.metadata_cost_label_output'],
  cacheRead: m['dashboard.routing.editor.metadata_cost_label_cache_read'],
  cacheWrite: m['dashboard.routing.editor.metadata_cost_label_cache_write'],
  reasoning: m['dashboard.routing.editor.metadata_cost_label_reasoning'],
  inputAudio: m['dashboard.routing.profile.price_input_audio'],
  outputAudio: m['dashboard.routing.profile.price_output_audio'],
  image: m['dashboard.routing.profile.price_image'],
  webSearch: m['dashboard.routing.profile.price_web_search'],
  request: m['dashboard.routing.profile.price_request'],
};

/** What one unit of each price buys; token prices are per million tokens, the rest per item. */
export const PRICE_UNIT: Readonly<Record<PriceKey, () => string>> = {
  input: m['dashboard.routing.profile.unit_million_tokens'],
  output: m['dashboard.routing.profile.unit_million_tokens'],
  cacheRead: m['dashboard.routing.profile.unit_million_tokens'],
  cacheWrite: m['dashboard.routing.profile.unit_million_tokens'],
  reasoning: m['dashboard.routing.profile.unit_million_tokens'],
  inputAudio: m['dashboard.routing.profile.unit_million_tokens'],
  outputAudio: m['dashboard.routing.profile.unit_million_tokens'],
  image: m['dashboard.routing.profile.unit_image'],
  webSearch: m['dashboard.routing.profile.unit_call'],
  request: m['dashboard.routing.profile.unit_request'],
};

export type MetadataRecord = Readonly<Record<string, unknown>>;

export const objectAt = (value: MetadataRecord | undefined, key: string): MetadataRecord => {
  const nested = value?.[key];
  return isPlainObject(nested) ? nested : {};
};

/** Setting a key to `undefined` clears it, which is how a merge drops a field the user emptied. */
export const withKey = (source: MetadataRecord, key: string, next: unknown): MetadataRecord => {
  const merged = { ...source };
  if (next === undefined) delete merged[key];
  else merged[key] = next;
  return merged;
};

/** An emptied group is dropped too, so clearing the last override leaves no `{}` behind. */
export const withNested = (source: MetadataRecord, group: string, key: string, next: unknown): MetadataRecord => {
  const nested = withKey(objectAt(source, group), key, next);
  return withKey(source, group, Object.keys(nested).length === 0 ? undefined : nested);
};

export const numberAt = (value: MetadataRecord | undefined, group: string, key: string): number | undefined => {
  const raw = objectAt(value, group)[key];
  return typeof raw === 'number' ? raw : undefined;
};

export const booleanAt = (value: MetadataRecord | undefined, group: string, key: string): boolean | undefined => {
  const raw = objectAt(value, group)[key];
  return typeof raw === 'boolean' ? raw : undefined;
};

export type PriceTier = Readonly<Record<string, unknown>> & {
  readonly tier?: { readonly type?: 'context'; readonly size?: number };
};

export const tiersAt = (value: MetadataRecord | undefined): readonly PriceTier[] | undefined => {
  const raw = objectAt(value, 'cost')['tiers'];
  return Array.isArray(raw) ? raw.filter(isPlainObject) : undefined;
};

/** A tier's trigger lives under `tier.size`, mirroring the models.dev `cost.tiers` shape. */
export const tierSize = (tier: PriceTier): number | undefined =>
  typeof tier.tier?.size === 'number' ? tier.tier.size : undefined;

export const withTierSize = (tier: PriceTier, size: number | undefined): PriceTier => ({
  ...tier,
  tier: { type: 'context', ...(size === undefined ? {} : { size }) },
});

// Built per call with the UI locale: a module-level `Intl.NumberFormat(undefined)` follows the browser's
// language instead (and `setLocale` switches without a reload), so an English UI read "US$2.00".
export const formatPrice = (value: number): string =>
  new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
// Token counts read "128K" / "1M" in every locale, as everywhere else in the dashboard.
export const formatTokens = (value: number): string => formatCompactTokenCount(value);

/**
 * What a group resolves to once the reference model is merged under the model's own overrides,
 * the way the server resolves `extend`: objects merge key by key and `tiers` replaces wholesale.
 */
export const effectiveGroup = (
  own: MetadataRecord | undefined,
  inherited: MetadataRecord | undefined,
  group: 'cost' | 'limit',
): MetadataRecord => ({ ...objectAt(inherited, group), ...objectAt(own, group) });
