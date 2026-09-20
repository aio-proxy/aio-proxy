import type { LanguageModelV2, LanguageModelV3, LanguageModelV4 } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import { wrapLanguageModel } from 'ai';
import { isPlainObject } from 'es-toolkit/predicate';

type BridgeLanguageModel = LanguageModelV2 | LanguageModelV3 | LanguageModelV4;

/** The two tool choices the AI SDK enforces on the client once a step answers without a matching tool call. */
type EnforcedToolChoice = { readonly type: 'required' } | { readonly type: 'tool'; readonly toolName: string };

export type ToolChoiceCall<TSettings> = {
  readonly model: BridgeLanguageModel;
  readonly settings: TSettings;
};

/**
 * Keeps a caller's `required` / named tool choice out of the AI SDK's own
 * enforcement while still sending it upstream.
 *
 * `ai` 7.0.9+ raises `ToolChoiceViolationError` when the caller asked for
 * `required` or a named tool and the model answered with text instead. For a
 * proxy that is upstream's verdict to give, not ours: raw passthrough has no
 * such check, so leaving the enforcement on makes one request succeed or fail
 * depending only on which transport served it, and it would turn a text answer
 * that shipped fine before into a candidate failure and a failover.
 *
 * So `streamText` only ever sees `auto`, and middleware puts the real choice
 * back on the model call, leaving the provider request identical to the one the
 * caller's intent produced before the enforcement existed.
 */
export function withUnenforcedToolChoice<TSettings extends object>({
  model,
  settings,
}: ToolChoiceCall<TSettings>): ToolChoiceCall<TSettings> {
  const enforced = enforcedToolChoice(settings);
  if (enforced === undefined) return { model, settings };
  return {
    model: wrapLanguageModel({ model, middleware: forwardToolChoice(enforced) }),
    settings: { ...settings, toolChoice: 'auto' },
  };
}

function enforcedToolChoice(settings: object): EnforcedToolChoice | undefined {
  const choice: unknown = Reflect.get(settings, 'toolChoice');
  if (choice === 'required') return { type: 'required' };
  if (!isPlainObject(choice) || choice['type'] !== 'tool') return undefined;
  const toolName = choice['toolName'];
  return typeof toolName === 'string' ? { type: 'tool', toolName } : undefined;
}

function forwardToolChoice(toolChoice: EnforcedToolChoice): LanguageModelMiddleware {
  return { transformParams: ({ params }) => Promise.resolve({ ...params, toolChoice }) };
}
