import type { ModelDescriptor } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { type ThinkingMode, classifyProvider } from '../classify';
import type { AntigravityFamily } from '../collapse';

// Effort levels each thinking mode actually accepts, mirroring src/protocol/thinking.ts:
// claude wires resolve an adaptive budget from CLAUDE_ADAPTIVE, gemini wires go through
// normalizeGeminiEffort (which folds xhigh down to high and rejects everything above).
// Publishing these lets the host clamp before the plugin has to throw.
//
// The literal type matters: ModelMetadataInput types reasoningOptions[].values as the
// ReasoningEffort enum union, so a plain string[] is not assignable.
type AdvertisedEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max';

const CLAUDE_EFFORTS: readonly AdvertisedEffort[] = ['low', 'medium', 'high', 'max'];
const GEMINI_EFFORTS: readonly AdvertisedEffort[] = ['none', 'low', 'medium', 'high'];
const GEMINI_MINIMAL_EFFORTS: readonly AdvertisedEffort[] = ['none', 'minimal', 'low', 'medium', 'high'];
const GEMINI_MINIMAL_SUFFIX = '-extra-low';

export function withEffortMetadata(
  language: readonly ModelDescriptor[],
  families: readonly AntigravityFamily[],
): ModelDescriptor[] {
  const modeByWire = new Map<string, ThinkingMode>();
  for (const family of families) {
    // suppressedWireIds are hidden from the picker but still routable, so they
    // must inherit their family's mode rather than fall back to classifyProvider.
    for (const id of [
      family.base,
      ...family.variants.map((variant) => variant.model),
      ...(family.suppressedWireIds ?? []),
    ]) {
      modeByWire.set(id, family.thinking.mode);
    }
  }
  return language.map((descriptor) => {
    const values = effortValues(descriptor, modeByWire.get(descriptor.id) ?? classifyProvider(descriptor));
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

function effortValues(descriptor: ModelDescriptor, mode: ThinkingMode): readonly AdvertisedEffort[] | undefined {
  if (mode === 'claude') return CLAUDE_EFFORTS;
  if (mode !== 'gemini') return undefined;
  // geminiMinimal only accepts an extra-low wire carrying a positive budget.
  const minimal = descriptor.id.endsWith(GEMINI_MINIMAL_SUFFIX) && thinkingBudget(descriptor.extra) > 0;
  return minimal ? GEMINI_MINIMAL_EFFORTS : GEMINI_EFFORTS;
}

// `extra` is JsonValue on the descriptor; widening to unknown lets isPlainObject narrow it
// to an indexable record, the same shape classifyProvider reads the provider tokens from.
function thinkingBudget(extra: unknown): number {
  if (!isPlainObject(extra)) return 0;
  const source = isPlainObject(extra['antigravity']) ? extra['antigravity'] : extra;
  const budget = source['thinkingBudget'];
  return typeof budget === 'number' && Number.isFinite(budget) ? budget : 0;
}
