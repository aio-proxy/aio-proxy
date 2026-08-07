import { z } from 'zod';

import type { ModelInvocation } from '../adapter';
import { normalizeEffort } from '../reasoning-effort/index';
import { readRequestText } from '../request';

const bodySchema = z.object({}).catchall(z.unknown());

export async function rewriteAnthropicRawEffort(
  raw: Request,
  resolvedModel: string,
  supportedEfforts: ReadonlySet<string>,
): Promise<Request> {
  // Read the decoded body text once so a no-op rewrite can forward it verbatim
  // instead of round-tripping through JSON (which would silently truncate large
  // integers and drop the client's exact byte representation).
  const bodyText = await readRequestText(raw);
  const body = bodySchema.parse(JSON.parse(bodyText));
  const thinking = body['thinking'];
  const thinkingDisabled =
    typeof thinking === 'object' && thinking !== null && (thinking as { readonly type?: unknown }).type === 'disabled';
  const outputConfig = body['output_config'];
  const currentEffort =
    typeof outputConfig === 'object' &&
    outputConfig !== null &&
    typeof (outputConfig as { effort?: unknown }).effort === 'string'
      ? (outputConfig as { effort: string }).effort
      : undefined;
  let nextOutputConfig = outputConfig;
  if (thinkingDisabled && currentEffort !== undefined) {
    const sanitized = { ...(outputConfig as Record<string, unknown>) };
    delete sanitized['effort'];
    nextOutputConfig = Object.keys(sanitized).length === 0 ? undefined : sanitized;
  } else if (currentEffort !== undefined) {
    const nextEffort = normalizeEffort(currentEffort, supportedEfforts);
    if (nextEffort !== currentEffort) {
      nextOutputConfig = { ...(outputConfig as object), effort: nextEffort };
    }
  }

  const headers = new Headers(raw.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  // Anthropic carries the model in the body (unlike Gemini's URL), so any change
  // to model or effort forces a re-serialization. Only when neither changes can
  // we forward the untouched original bytes.
  const modelUnchanged = body['model'] === resolvedModel;
  const effortUnchanged = nextOutputConfig === outputConfig;
  const forwardedBody =
    modelUnchanged && effortUnchanged
      ? bodyText
      : JSON.stringify({
          ...body,
          model: resolvedModel,
          output_config: nextOutputConfig,
        });
  return new Request(raw, {
    method: raw.method,
    body: forwardedBody,
    headers,
  });
}

type ThinkingProviderOptions = {
  readonly aioProxy?: { readonly thinking?: { readonly mode?: string; readonly effort?: string } };
};

type SettingsWithThinking = ModelInvocation['settings'] & { readonly providerOptions?: ThinkingProviderOptions };

export function normalizeAnthropicInvocationEffort(
  invocation: ModelInvocation,
  supportedEfforts: ReadonlySet<string>,
): ModelInvocation {
  const settings = invocation.settings as SettingsWithThinking | undefined;
  const providerOptions = settings?.providerOptions;
  const thinking = providerOptions?.aioProxy?.thinking;
  if (thinking?.effort === undefined) return invocation;
  const effort = normalizeEffort(thinking.effort, supportedEfforts);
  if (effort === thinking.effort) return invocation;
  return {
    ...invocation,
    settings: {
      ...settings,
      providerOptions: {
        ...providerOptions,
        aioProxy: { ...providerOptions?.aioProxy, thinking: { ...thinking, effort } },
      },
    } as NonNullable<ModelInvocation['settings']>,
  };
}
