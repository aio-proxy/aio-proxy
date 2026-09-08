import { EFFORT_LADDER as LADDER, foldEffortSpelling } from '@aio-proxy/types';

import type { AiSdkCallSettings } from '../../ai-sdk-bridge';
import type { ModelInvocation } from '../adapter';

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

// Neither LanguageModelCallOptions (ai@7.0.8 dist/index.d.ts:524-586) nor the
// transform-level settings shapes declare providerOptions, so reach it through a
// local carrier — the same idiom as SettingsWithThinking in
// protocol/anthropic-messages/effort.ts.
type ProviderOptionsCarrier = {
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

function providerOptionsOf(settings: unknown): ProviderOptionsCarrier['providerOptions'] {
  return (settings as ProviderOptionsCarrier | undefined)?.providerOptions;
}

// Only an actual ladder level may ride the canonical channel. The ingress effort
// schemas accept any string so a future level is not rejected, which makes typos and
// padded spellings expected input — and normalizeEffort treats an off-ladder request as
// "above everything supported" and escalates it to the highest supported level, the
// opposite of this module's downgrade-only contract. Keeping such a value off the
// channel restores "unknown effort is dropped, the provider applies its own default".
// (The raw-passthrough path in protocol/openai-responses.ts calls normalizeEffort with
// the client's string directly and still escalates; that asymmetry is pre-existing.)
function ladderEffort(effort: string): string | undefined {
  const wanted = canonical(effort);
  return LADDER.includes(wanted as (typeof LADDER)[number]) ? wanted : undefined;
}

// The canonical (full-ladder) effort travels in providerOptions.aioProxy.effort because
// the AI SDK's `reasoning` union stops at `xhigh` — folding `max` into `xhigh` at ingress
// would make per-candidate clamping pick `high` for a provider that really supports `max`.
function canonicalRequestedEffort(settings: ModelInvocation['settings']): string | undefined {
  const carried = providerOptionsOf(settings)?.['aioProxy']?.['effort'];
  const fromCarrier = typeof carried === 'string' ? ladderEffort(carried) : undefined;
  if (fromCarrier !== undefined) return fromCarrier;
  // settings.reasoning may hold an SDK-only level such as `provider-default`, which is
  // not a ladder rank; clamping it would escalate rather than downgrade.
  return typeof settings?.reasoning === 'string' ? ladderEffort(settings.reasoning) : undefined;
}

function mergeEffort<T>(settings: T, sdk: AiSdkReasoning | undefined, effort: string | undefined): T {
  const providerOptions = providerOptionsOf(settings);
  return {
    ...settings,
    ...(sdk === undefined ? {} : { reasoning: sdk }),
    ...(effort === undefined
      ? {}
      : { providerOptions: { ...providerOptions, aioProxy: { ...providerOptions?.['aioProxy'], effort } } }),
  } as T;
}

// Merge both effort representations into a settings object: the canonical value for
// providers that can express more than the SDK union, and the SDK value for the AI SDK
// model path. Sibling providerOptions namespaces and other aioProxy keys are preserved.
// A level neither representation can express is dropped, so the provider defaults.
// T is only loosely constrained because callers pass transform-level settings shapes
// whose extra keys (stream, responseFormat) are not in LanguageModelCallOptions.
export function reasoningSettings<T extends object>(settings: T, effort: string | undefined): T {
  if (effort === undefined) return settings;
  const sdk = toAiSdkReasoning(effort);
  const ladder = ladderEffort(effort);
  if (sdk === undefined && ladder === undefined) return settings;
  return mergeEffort(settings, sdk, ladder);
}

// Clamp the requested effort shared by the OpenAI Responses/Completions and Gemini model
// paths down to what this candidate advertises. Identity when nothing is requested, the
// supported set is empty, or the request is already supported. Both representations are
// rewritten together so a provider reading either one sees the same decision.
export function clampSdkReasoning(invocation: ModelInvocation, supported: ReadonlySet<string>): ModelInvocation {
  const requested = canonicalRequestedEffort(invocation.settings);
  if (requested === undefined || supported.size === 0) return invocation;
  const clamped = normalizeEffort(requested, supported);
  const sdk = toAiSdkReasoning(clamped);
  const settings = invocation.settings as NonNullable<ModelInvocation['settings']>;
  if (clamped === providerOptionsOf(settings)?.['aioProxy']?.['effort'] && sdk === settings.reasoning) {
    return invocation;
  }
  return { ...invocation, settings: mergeEffort(settings, sdk, clamped) };
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
// ceiling (`max`) maps to the highest expressible level (`xhigh`) so the model
// path still gets a usable value while the canonical level rides alongside in
// providerOptions.aioProxy.effort; a level the SDK does not know at all yields
// undefined (provider default applies).
function toAiSdkReasoning(effort: string): AiSdkReasoning | undefined {
  const wanted = canonical(effort);
  if (AI_SDK_REASONING.has(wanted as AiSdkReasoning)) return wanted as AiSdkReasoning;
  // Above the SDK ceiling but on our ladder (e.g. `max`): express as `xhigh`.
  const wantedRank = LADDER.indexOf(wanted as (typeof LADDER)[number]);
  const xhighRank = LADDER.indexOf('xhigh');
  return wantedRank > xhighRank ? 'xhigh' : undefined;
}
