import { createProxyFetch } from '@aio-proxy/core';
import {
  type DashboardProviderDraftCatalogResponse,
  type DashboardProviderDraftTestResponse,
  type Provider,
  ProviderKind,
  ProviderProtocol,
  ProviderSchema,
} from '@aio-proxy/types';

import { effectiveProxy, materializeProviders } from '../../provider-runtime';
import { withAttemptLogContext, withRequestLogContext } from '../../request-logging';
import type { RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';

export { resolveProviderDraft } from './provider-draft-resolution';

const failure = <Code extends string>(code: Code) => ({
  ok: false as const,
  error: { code, recoverable: true as const },
});

export async function loadProviderDraftCatalog(
  state: ServerState,
  provider: Exclude<Provider, { kind: ProviderKind.OAuth }>,
): Promise<DashboardProviderDraftCatalogResponse> {
  if (provider.kind === ProviderKind.AiSdk) return loadAiSdkDraftCatalog(state, provider);

  try {
    const runtime = materializeDraft(state, provider);
    const raw = runtime.raw?.resolve({ protocol: provider.protocol, modelId: '' });
    if (raw === undefined) return failure('catalog_unavailable');
    const signal = AbortSignal.timeout(5_000);
    const models = new Set<string>();
    let path: string | undefined = catalogPath(provider.protocol);
    while (path !== undefined) {
      const response = await raw.invoke(new Request(`http://provider-draft.invalid${path}`, { signal }), undefined, {
        upstreamStream: false,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return failure('catalog_unavailable');
      }
      const page = catalogPage(provider.protocol, await response.json());
      for (const model of page.models) models.add(model);
      path = page.nextPath;
    }
    return { ok: true, models: [...models] };
  } catch {
    return failure('catalog_unavailable');
  }
}

// ai-sdk runtimes expose no raw capability and no protocol field, so the api
// loader cannot serve them. Convention over schema: baseURL/apiKey/headers are the
// @ai-sdk/openai-compatible option keys, and the listing must be OpenAI-shaped.
async function loadAiSdkDraftCatalog(
  state: ServerState,
  provider: Extract<Provider, { kind: ProviderKind.AiSdk }>,
): Promise<DashboardProviderDraftCatalogResponse> {
  const baseURL = provider.options?.['baseURL'];
  if (typeof baseURL !== 'string' || baseURL.trim() === '') return failure('catalog_unsupported');
  const apiKey = provider.options?.['apiKey'];
  const configuredHeaders = provider.options?.['headers'];
  // Proxy only. The runtime path also wraps this in createProviderRequestTransformFetch +
  // createObservedFetch (materialize.ts:156-159), but both are provably inert here: the
  // transform fetch returns early unless currentProviderAttemptContext() names this
  // provider, and createObservedFetch passes through with no debug scope. Draft catalog
  // loading establishes neither — the api loader above has the same gap. Wiring them in
  // would look like transform support without providing any.
  const fetchWithProxy = createProxyFetch(effectiveProxy(state.currentConfig().proxy, provider.proxy));
  try {
    const response = await fetchWithProxy(`${baseURL.replace(/\/+$/u, '')}/models`, {
      signal: AbortSignal.timeout(5_000),
      headers: {
        // An @ai-sdk/anthropic-shaped provider authenticates via options.headers
        // (x-api-key), not a bearer token; without this it 401s here while
        // /draft/test on the same draft succeeds.
        ...(typeof configuredHeaders === 'object' && configuredHeaders !== null
          ? (configuredHeaders as Record<string, string>)
          : {}),
        ...(typeof apiKey === 'string' && apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure('catalog_unavailable');
    }
    const page = catalogPage(ProviderProtocol.OpenAICompatible, await response.json());
    return { ok: true, models: [...new Set(page.models)] };
  } catch {
    return failure('catalog_unavailable');
  }
}

export async function testProviderDraft(
  state: ServerState,
  provider: Exclude<Provider, { kind: ProviderKind.OAuth }>,
  modelId: string,
): Promise<DashboardProviderDraftTestResponse> {
  if (!provider.models?.includes(modelId)) return failure('model_not_enabled');

  try {
    const testProvider = ProviderSchema.parse({ ...provider, alias: undefined, enabled: true, models: [modelId] });
    if (testProvider.kind === ProviderKind.OAuth) return failure('test_request_failed');
    const runtime = materializeDraftRuntime(state, testProvider);
    const targetProtocol =
      testProvider.kind === ProviderKind.Api
        ? testProvider.protocol
        : runtime.provider.model?.targetProtocol?.(modelId);
    const passed = await withDraftAttempt(testProvider, modelId, targetProtocol, async () => {
      if (testProvider.kind === ProviderKind.Api) {
        return (await runtime.probe()) === 'OK';
      }
      if (runtime.provider.model === undefined) return false;
      await runtime.provider.model.ensureAvailable?.();
      const signal = AbortSignal.timeout(10_000);
      const stream = runtime.provider.model.invoke({
        context: {
          requestId: crypto.randomUUID(),
          session: { key: `sha256:${'0'.repeat(64)}`, source: 'internal' },
        },
        messages: [{ role: 'user', content: 'ping' }],
        modelId,
        settings: { maxOutputTokens: 1 },
        signal,
      });
      for await (const _part of stream) {
        // Fully consume the single validation request so provider stream errors are observed.
      }
      return true;
    });
    return passed ? { ok: true } : failure('test_request_failed');
  } catch {
    return failure('test_request_failed');
  }
}

function materializeDraftRuntime(
  state: ServerState,
  provider: Exclude<Provider, { kind: ProviderKind.OAuth }>,
): { readonly provider: RuntimeProviderInstance; readonly probe: () => Promise<'OK' | 'FAIL'> } {
  const runtime = materializeProviders({ ...state.currentConfig(), invalidProviders: [], providers: [provider] });
  const instance = runtime.providers[0];
  const probe = runtime.probes.get(provider.id);
  if (instance === undefined || probe === undefined) throw new Error('draft provider materialization failed');
  return { provider: instance, probe };
}

function materializeDraft(
  state: ServerState,
  provider: Exclude<Provider, { kind: ProviderKind.OAuth }>,
): RuntimeProviderInstance {
  return materializeDraftRuntime(state, provider).provider;
}

function withDraftAttempt<T>(
  provider: Exclude<Provider, { kind: ProviderKind.OAuth }>,
  modelId: string,
  targetProtocol: ProviderProtocol | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const sourceProtocol = provider.kind === ProviderKind.Api ? provider.protocol : ProviderProtocol.OpenAIResponse;
  return withRequestLogContext({ requestId: crypto.randomUUID(), debug: false, logger: () => {} }, () =>
    withAttemptLogContext(
      {
        attemptIndex: 0,
        modelId,
        providerId: provider.id,
        requestedModelId: modelId,
        sourceProtocol,
        ...(targetProtocol === undefined ? {} : { targetProtocol }),
      },
      operation,
    ),
  );
}

function catalogPath(protocol: ProviderProtocol): string {
  return protocol === ProviderProtocol.Gemini ? '/v1beta/models' : '/v1/models';
}

type CatalogPage = {
  readonly models: readonly string[];
  readonly nextPath?: string;
};

function catalogPage(protocol: ProviderProtocol, payload: unknown): CatalogPage {
  const models = catalogModels(protocol, payload);
  if (protocol === ProviderProtocol.Gemini) {
    const pageToken = stringProperty(payload, 'nextPageToken');
    return pageToken === undefined
      ? { models }
      : { models, nextPath: `/v1beta/models?pageToken=${encodeURIComponent(pageToken)}` };
  }
  if (protocol === ProviderProtocol.Anthropic && booleanProperty(payload, 'has_more')) {
    const afterId = stringProperty(payload, 'last_id');
    if (afterId === undefined) throw new TypeError('invalid catalog continuation');
    return { models, nextPath: `/v1/models?after_id=${encodeURIComponent(afterId)}` };
  }
  return { models };
}

function stringProperty(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) throw new TypeError('invalid catalog');
  const value = Reflect.get(payload, key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function booleanProperty(payload: unknown, key: string): boolean {
  if (typeof payload !== 'object' || payload === null) throw new TypeError('invalid catalog');
  return Reflect.get(payload, key) === true;
}

function catalogModels(protocol: ProviderProtocol, payload: unknown): readonly string[] {
  if (typeof payload !== 'object' || payload === null) throw new TypeError('invalid catalog');
  const rows = Reflect.get(payload, protocol === ProviderProtocol.Gemini ? 'models' : 'data');
  if (!Array.isArray(rows)) throw new TypeError('invalid catalog');
  const models = rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const value = Reflect.get(row, protocol === ProviderProtocol.Gemini ? 'name' : 'id');
    if (typeof value !== 'string' || value.trim() === '') return [];
    return [protocol === ProviderProtocol.Gemini ? value.replace(/^models\//u, '') : value];
  });
  return [...new Set(models)];
}
