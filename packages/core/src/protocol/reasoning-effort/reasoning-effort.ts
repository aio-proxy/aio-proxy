import type { AiSdkCallSettings } from '../../ai-sdk-bridge';
import type { ModelInvocation } from '../adapter';

// Ascending reasoning-effort ladder. Index = rank; higher index = more effort.
const LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

// Common spellings folded to the canonical ladder value before clamping.
const ALIASES: Readonly<Record<string, string>> = {
  'x-high': 'xhigh',
  x_high: 'xhigh',
  extrahigh: 'xhigh',
};

function canonical(effort: string): string {
  const lower = effort.toLowerCase();
  return ALIASES[lower] ?? lower;
}

// Clamp the requested effort down to the highest supported level at or below it.
// Empty support => return the original string verbatim (no capability info; do
// not canonicalize or mangle casing). An effort not on the ladder clamps to the
// highest supported level; if only off-ladder levels are supported, pass through.
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
  // Nothing supported at or below the request: clamp up to the lowest supported.
  return supportedRanks[0]!.level;
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
// is absent, non-string, or already at a supported level.
export function clampSdkReasoning(invocation: ModelInvocation, supported: ReadonlySet<string>): ModelInvocation {
  const reasoning = invocation.settings?.reasoning;
  if (typeof reasoning !== 'string') return invocation;
  const next = normalizeEffort(reasoning, supported);
  if (next === reasoning) return invocation;
  const settings = invocation.settings as NonNullable<ModelInvocation['settings']>;
  return { ...invocation, settings: { ...settings, reasoning: next as typeof settings.reasoning } };
}

export type AiSdkReasoning = NonNullable<AiSdkCallSettings['reasoning']>;
const AI_SDK_REASONING: readonly AiSdkReasoning[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'provider-default',
];

// Ingress accepts any effort string (so a future/alias level is not rejected),
// but the AI SDK model path only takes the levels it knows. Keep a recognized
// level for downstream capability clamping; drop an unknown one (e.g. `max`) so
// the provider applies its own default.
export function reasoningSetting(effort: string | undefined): { readonly reasoning?: AiSdkReasoning } {
  const known = AI_SDK_REASONING.find((level) => level === effort);
  return known === undefined ? {} : { reasoning: known };
}
