import { foldEffortSpelling } from '@aio-proxy/types';

import type { AiSdkCallSettings } from '../../ai-sdk-bridge';
import type { ModelInvocation } from '../adapter';

// Ascending reasoning-effort ladder. Index = rank; higher index = more effort.
const LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

// Fold common spellings to the canonical ladder value before clamping. Unlike
// the alias matcher's canonicalEffort, this wire-path clamp must NOT trim:
// padded input stays off-ladder and is treated as unknown.
function canonical(effort: string): string {
  return foldEffortSpelling(effort.toLowerCase());
}

// Clamp the requested effort down to the highest supported level at or below it.
// This is downgrade-only: it never raises effort above what the client asked for
// (raising would silently increase latency/cost). Empty support => return the
// original string verbatim (no capability info; do not canonicalize or mangle
// casing). An effort above everything supported clamps to the highest supported
// level; an effort at or below the lowest supported level, or off-ladder with
// nothing at/below it, is left as the client's canonical value.
export function normalizeEffort(effort: string, supported: ReadonlySet<string>): string {
  // No capability info: forward the client's value verbatim (do not even
  // canonicalize — e.g. Gemini's uppercase `HIGH` must survive untouched).
  if (supported.size === 0) return effort;
  const wanted = canonical(effort);
  if (supported.has(wanted)) return wanted;

  const supportedRanks = LADDER.map((level, rank) => ({ level, rank })).filter((entry) => supported.has(entry.level));
  if (supportedRanks.length === 0) return effort;

  const wantedRank = LADDER.indexOf(wanted as (typeof LADDER)[number]);
  // Off-ladder or above everything: take the highest supported level.
  if (wantedRank === -1) return supportedRanks[supportedRanks.length - 1]!.level;

  const atOrBelow = supportedRanks.filter((entry) => entry.rank <= wantedRank);
  if (atOrBelow.length > 0) return atOrBelow[atOrBelow.length - 1]!.level;
  // Nothing supported at or below the request: the client asked for less than the
  // upstream's lowest level. Downgrade-only means we must not raise it, so keep
  // the client's canonical value rather than clamping *up* to the lowest support.
  return wanted;
}

type EffortReasoningOption = { readonly type?: unknown; readonly values?: unknown };

// Narrow an unknown model object to its advertised effort levels, mirroring
// server/model-capabilities: reasoning_options[type==='effort'].values.
export function modelEffortValues(model: unknown): ReadonlySet<string> {
  if (typeof model !== 'object' || model === null) return new Set();
  const options = (model as { readonly reasoning_options?: unknown }).reasoning_options;
  if (!Array.isArray(options)) return new Set();
  const effort = options.find(
    (option): option is EffortReasoningOption =>
      typeof option === 'object' && option !== null && (option as EffortReasoningOption).type === 'effort',
  );
  const values = effort?.values;
  if (!Array.isArray(values)) return new Set();
  return new Set(values.filter((value): value is string => typeof value === 'string'));
}

// Clamp the AI-SDK reasoning effort (settings.reasoning) shared by the
// OpenAI Responses/Completions and Gemini model paths. Identity when reasoning
// is absent or already at a supported level. The result is always constrained
// back to a level the AI SDK understands (an out-of-union input like a raw
// `max` was already folded to `xhigh` by reasoningSetting before it got here).
export function clampSdkReasoning(invocation: ModelInvocation, supported: ReadonlySet<string>): ModelInvocation {
  const reasoning = invocation.settings?.reasoning;
  if (typeof reasoning !== 'string') return invocation;
  const clamped = toAiSdkReasoning(normalizeEffort(reasoning, supported));
  if (clamped === reasoning) return invocation;
  const settings = invocation.settings as NonNullable<ModelInvocation['settings']>;
  return { ...invocation, settings: { ...settings, reasoning: clamped } };
}

export type AiSdkReasoning = NonNullable<AiSdkCallSettings['reasoning']>;
const AI_SDK_REASONING: ReadonlySet<AiSdkReasoning> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'provider-default',
]);

// Fold an arbitrary effort string to the level the AI SDK model path can carry.
// Aliases canonicalize (`x-high` -> `xhigh`); a ladder level above the SDK's
// ceiling (`max`) maps to the highest expressible level (`xhigh`) so it still
// participates in per-candidate downgrading rather than being dropped; a level
// the SDK does not know at all yields undefined (provider default applies).
function toAiSdkReasoning(effort: string): AiSdkReasoning | undefined {
  const wanted = canonical(effort);
  if (AI_SDK_REASONING.has(wanted as AiSdkReasoning)) return wanted as AiSdkReasoning;
  // Above the SDK ceiling but on our ladder (e.g. `max`): express as `xhigh`.
  const wantedRank = LADDER.indexOf(wanted as (typeof LADDER)[number]);
  const xhighRank = LADDER.indexOf('xhigh');
  return wantedRank > xhighRank ? 'xhigh' : undefined;
}

// Ingress accepts any effort string (so a future/alias level is not rejected).
// Keep a level the model path can carry so per-candidate capability clamping can
// still downgrade it; drop a genuinely unknown level so the provider defaults.
export function reasoningSetting(effort: string | undefined): { readonly reasoning?: AiSdkReasoning } {
  if (effort === undefined) return {};
  const known = toAiSdkReasoning(effort);
  return known === undefined ? {} : { reasoning: known };
}
