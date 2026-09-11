import type { ModelDescriptor } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { type ThinkingMode, classifyProvider } from '../classify';
import { type AntigravityFamily, splitVariantEfforts } from '../collapse';

// Effort levels each thinking mode actually accepts, mirroring src/protocol/thinking.ts:
// claude wires resolve an adaptive budget from CLAUDE_ADAPTIVE, gemini wires go through
// normalizeGeminiEffort (which folds everything above high back down to high),
// and a gemini wire inside a split family additionally only accepts the efforts its own
// variant declares. Publishing these lets the host clamp before the plugin has to throw.
//
// The literal type matters: ModelMetadataInput types reasoningOptions[].values as the
// ReasoningEffort enum union, so a plain string[] is not assignable.
type AdvertisedEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max';

const CLAUDE_EFFORTS: readonly AdvertisedEffort[] = ['low', 'medium', 'high', 'max'];
const GEMINI_EFFORTS: readonly AdvertisedEffort[] = ['none', 'low', 'medium', 'high'];
const GEMINI_LADDER: readonly AdvertisedEffort[] = ['none', 'minimal', 'low', 'medium', 'high'];
const GEMINI_MINIMAL_SUFFIX = '-extra-low';

// thinking.ts resolves a wire's family by base or variant model only, so a suppressed
// wire carries the family's mode but never its split narrowing.
type WireThinking = { readonly mode: ThinkingMode; readonly family?: AntigravityFamily };

export function withEffortMetadata(
  language: readonly ModelDescriptor[],
  families: readonly AntigravityFamily[],
): ModelDescriptor[] {
  const thinkingByWire = new Map<string, WireThinking>();
  for (const family of families) {
    // suppressedWireIds are hidden from the picker but still routable, so they
    // must inherit their family's mode rather than fall back to classifyProvider.
    for (const id of family.suppressedWireIds ?? []) {
      thinkingByWire.set(id, { mode: family.thinking.mode });
    }
    for (const id of [family.base, ...family.variants.map((variant) => variant.model)]) {
      thinkingByWire.set(id, { mode: family.thinking.mode, family });
    }
  }
  return language.map((descriptor) => {
    const wire = thinkingByWire.get(descriptor.id) ?? { mode: classifyProvider(descriptor) };
    const values = effortValues(descriptor, wire);
    if (values === undefined) return descriptor;
    return {
      ...descriptor,
      modelMetadata: {
        ...descriptor.modelMetadata,
        capabilities: {
          ...descriptor.modelMetadata?.capabilities,
          reasoning: true,
          reasoningOptions: [{ type: 'effort', values: [...values] }],
        },
      },
    };
  });
}

function effortValues(descriptor: ModelDescriptor, wire: WireThinking): readonly AdvertisedEffort[] | undefined {
  if (wire.mode === 'claude') return CLAUDE_EFFORTS;
  if (wire.mode !== 'gemini') return undefined;
  // geminiMinimal only accepts an extra-low wire carrying a positive budget.
  const minimal = descriptor.id.endsWith(GEMINI_MINIMAL_SUFFIX) && thinkingBudget(descriptor.extra) > 0;
  if (wire.family?.kind !== 'split') {
    return minimal ? GEMINI_LADDER : GEMINI_EFFORTS;
  }
  const accepted = new Set<string>([
    'none',
    ...(minimal ? ['minimal'] : []),
    ...splitVariantEfforts(wire.family, descriptor.id),
  ]);
  return GEMINI_LADDER.filter((effort) => accepted.has(effort));
}

// `extra` is JsonValue on the descriptor; widening to unknown lets isPlainObject narrow it
// to an indexable record, the same shape classifyProvider reads the provider tokens from.
function thinkingBudget(extra: unknown): number {
  if (!isPlainObject(extra)) return 0;
  const source = isPlainObject(extra['antigravity']) ? extra['antigravity'] : extra;
  const budget = source['thinkingBudget'];
  return typeof budget === 'number' && Number.isFinite(budget) ? budget : 0;
}
