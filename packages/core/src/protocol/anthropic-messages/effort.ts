import { z } from 'zod';

import type { ModelInvocation } from '../adapter';
import { normalizeEffort } from '../reasoning-effort/index';
import { readJsonRequest } from '../request';

const bodySchema = z.object({}).catchall(z.unknown());

export async function rewriteAnthropicRawEffort(
  raw: Request,
  resolvedModel: string,
  supportedEfforts: ReadonlySet<string>,
): Promise<Request> {
  const body = bodySchema.parse(await readJsonRequest(raw));
  const outputConfig = body['output_config'];
  const nextOutputConfig =
    typeof outputConfig === 'object' &&
    outputConfig !== null &&
    typeof (outputConfig as { effort?: unknown }).effort === 'string'
      ? { ...outputConfig, effort: normalizeEffort((outputConfig as { effort: string }).effort, supportedEfforts) }
      : outputConfig;

  const headers = new Headers(raw.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Request(raw, {
    method: raw.method,
    body: JSON.stringify({
      ...body,
      model: resolvedModel,
      ...(nextOutputConfig === undefined ? {} : { output_config: nextOutputConfig }),
    }),
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
