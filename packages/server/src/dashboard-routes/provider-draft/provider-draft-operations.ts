import { BUNDLED_PROVIDERS, createProxyFetch, loadAiSdkProvider } from '@aio-proxy/core';
import {
  apiProviderEndpoints,
  type DashboardProviderDraftCatalogResponse,
  type DashboardProviderDraftTestResponse,
  type Provider,
  ProviderKind,
  ProviderProtocol,
  ProviderSchema,
} from '@aio-proxy/types';
import { uniq } from 'es-toolkit/array';
import { isPlainObject } from 'es-toolkit/predicate';

import { oauthExposedModels } from '../../plugin-runtime';
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
  provider: Provider,
): Promise<DashboardProviderDraftCatalogResponse> {
  // OAuth candidates come from oauthProviderEditView, not the draft catalog endpoint.
  if (provider.kind === ProviderKind.OAuth) return failure('catalog_unsupported');
  if (provider.kind === ProviderKind.AiSdk) return loadAiSdkDraftCatalog(state, provider);

  try {
    const primary = apiProviderEndpoints(provider)[0];
    const runtime = materializeDraft(state, provider);
    const raw = runtime.raw?.resolve({ protocol: primary.protocol, modelId: '' });
    if (raw === undefined) return failure('catalog_unavailable');
    const signal = AbortSignal.timeout(5_000);
    const models = new Set<string>();
    let path: string | undefined = catalogPath(primary.protocol);
    while (path !== undefined) {
      const response = await raw.invoke(new Request(`http://provider-draft.invalid${path}`, { signal }), undefined, {
        upstreamStream: false,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return failure('catalog_unavailable');
      }
      const page = catalogPage(primary.protocol, await response.json());
      for (const model of page.models) models.add(model);
      path = page.nextPath;
    }
    return { ok: true, models: [...models] };
  } catch {
    return failure('catalog_unavailable');
  }
}

// The AI SDK contract does not standardize model discovery. Custom packages may
// expose listModels(signal?) on their provider instance; otherwise retain the
// existing OpenAI-compatible options.baseURL + /models convention.
async function loadAiSdkDraftCatalog(
  state: ServerState,
  provider: Extract<Provider, { kind: ProviderKind.AiSdk }>,
): Promise<DashboardProviderDraftCatalogResponse> {
  // Proxy only. The runtime path also wraps this in createProviderRequestTransformFetch +
  // createObservedFetch (materialize.ts:156-159), but both are provably inert here: the
  // transform fetch returns early unless currentProviderAttemptContext() names this
  // provider, and createObservedFetch passes through with neither a debug scope nor an
  // attempt response observation. Draft catalog loading establishes none of the three —
  // the api loader above has the same gap. Wiring them in would look like transform
  // support without providing any.
  const fetchWithProxy = createProxyFetch(effectiveProxy(state.currentConfig().proxy, provider.proxy));
  let extensionUnavailable = false;
  if (BUNDLED_PROVIDERS[provider.packageName] === undefined) {
    try {
      const runtime = await loadAiSdkProvider(provider.packageName, {
        ...provider.options,
        fetch: fetchWithProxy,
      });
      if (typeof runtime?.listModels === 'function') {
        const models = catalogEntryIds(await runtime.listModels(AbortSignal.timeout(5_000)));
        if (models !== null) return { ok: true, models };
        extensionUnavailable = true;
      }
    } catch {
      extensionUnavailable = true;
    }
  }

  const baseURL = provider.options?.['baseURL'];
  if (typeof baseURL !== 'string' || baseURL.trim() === '') {
    return failure(extensionUnavailable ? 'catalog_unavailable' : 'catalog_unsupported');
  }
  try {
    const response = await fetchWithProxy(`${baseURL.replace(/\/+$/u, '')}/models`, {
      signal: AbortSignal.timeout(5_000),
      headers: catalogHeaders(provider.options),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure('catalog_unavailable');
    }
    const page = catalogPage(ProviderProtocol.OpenAICompatible, await response.json());
    return { ok: true, models: uniq(page.models) };
  } catch {
    return failure('catalog_unavailable');
  }
}

function catalogEntryIds(rows: unknown): readonly string[] | null {
  if (!Array.isArray(rows)) return null;
  return uniq(
    rows.flatMap((row) => {
      const id = typeof row === 'string' ? row : isPlainObject(row) ? row['id'] : undefined;
      if (typeof id !== 'string') return [];
      return id.trim() === '' ? [] : [id];
    }),
  );
}

// apiKey first, configured headers second — `upstreamHeaders` (core/.../api.ts:98-104),
// the schema contract at types/provider.ts:94 ("configured values win"), and
// @ai-sdk/openai-compatible itself all resolve the collision this way. A gateway whose
// real credential lives in options.headers must authenticate here exactly as it does in
// the proxy, or Load models reports catalog_unavailable for a provider that works.
// Headers.set is case-insensitive, so a configured `Authorization` in any casing replaces
// the bearer instead of being comma-joined onto it the way an object spread would.
function catalogHeaders(options: Readonly<Record<string, unknown>> | undefined): Headers {
  const headers = new Headers();
  const apiKey = options?.['apiKey'];
  if (typeof apiKey === 'string' && apiKey !== '') headers.set('authorization', `Bearer ${apiKey}`);
  const configured = options?.['headers'];
  // isPlainObject, not `typeof === 'object'`: the native check admits an array, which
  // would spread into a bogus `0:` header.
  if (isPlainObject(configured)) {
    for (const [name, value] of Object.entries(configured)) headers.set(name, String(value));
  }
  return headers;
}

export async function testProviderDraft(
  state: ServerState,
  provider: Provider,
  modelId: string,
): Promise<DashboardProviderDraftTestResponse> {
  if (provider.kind === ProviderKind.OAuth) return testOAuthProvider(state, provider, modelId);
  if (!provider.models?.includes(modelId)) return failure('model_not_enabled');

  try {
    const testProvider = ProviderSchema.parse({ ...provider, alias: undefined, enabled: true, models: [modelId] });
    // Unreachable: the entry point routes oauth to testOAuthProvider. Kept because
    // ProviderSchema.parse returns the full union — this narrows testProvider for
    // materializeDraftRuntime's Exclude<Provider, { kind: OAuth }> parameter.
    if (testProvider.kind === ProviderKind.OAuth) return failure('test_request_failed');
    const runtime = materializeDraftRuntime(state, testProvider);
    const targetProtocol =
      testProvider.kind === ProviderKind.Api
        ? apiProviderEndpoints(testProvider)[0].protocol
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

// Borrows the live runtime: an oauth provider cannot exist unsaved, and a
// one-shot materialization would drive plugin auth (and can rewrite stored
// credentials) from a read-only test button. Unsaved draft transforms are
// therefore NOT exercised here; the editor's rail copy says so.
function oauthDiscoveredCatalogIds(
  state: ServerState,
  providerId: string,
  runtime: RuntimeProviderInstance,
): readonly string[] {
  const stored = state.oauthProviderEditView(providerId)?.models;
  if (stored !== undefined && stored.length > 0) return stored;
  return Object.keys(runtime.upstreamMetadata ?? {});
}

async function testOAuthProvider(
  state: ServerState,
  provider: Extract<Provider, { kind: ProviderKind.OAuth }>,
  modelId: string,
): Promise<DashboardProviderDraftTestResponse> {
  const lease = state.acquireProviderSnapshot();
  try {
    const runtime = lease.snapshot.providers.find((candidate) => candidate.id === provider.id);
    const transport = runtime?.model;
    if (runtime === undefined || transport === undefined) return failure('test_request_failed');
    // Stored catalog, not `runtime.upstreamMetadata`: materialization already
    // subtracts the *saved* denylist from metadata, so a draft that re-enables a
    // hidden id would otherwise look undiscovered and return model_not_enabled.
    const catalogIds = oauthDiscoveredCatalogIds(state, provider.id, runtime);
    // Gate on the DRAFT denylist over the discovered catalog, so an unsaved hide
    // is honored and an empty excludedModels list exposes everything.
    if (!new Set(oauthExposedModels(catalogIds, provider.excludedModels)).has(modelId)) {
      return failure('model_not_enabled');
    }
    const passed = await withDraftAttempt(provider, modelId, transport.targetProtocol?.(modelId), async () => {
      await transport.ensureAvailable?.();
      const signal = AbortSignal.timeout(10_000);
      const stream = transport.invoke({
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
  } finally {
    lease.release();
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
  provider: Provider,
  modelId: string,
  targetProtocol: ProviderProtocol | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const sourceProtocol =
    provider.kind === ProviderKind.Api ? apiProviderEndpoints(provider)[0].protocol : ProviderProtocol.OpenAIResponse;
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

function geminiCatalog(protocol: ProviderProtocol): boolean {
  return protocol === ProviderProtocol.Gemini || protocol === ProviderProtocol.GeminiInteractions;
}

function catalogPath(protocol: ProviderProtocol): string {
  return geminiCatalog(protocol) ? '/v1beta/models' : '/v1/models';
}

type CatalogPage = {
  readonly models: readonly string[];
  readonly nextPath?: string;
};

function catalogPage(protocol: ProviderProtocol, payload: unknown): CatalogPage {
  const models = catalogModels(protocol, payload);
  if (geminiCatalog(protocol)) {
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
  const gemini = geminiCatalog(protocol);
  const rows = Reflect.get(payload, gemini ? 'models' : 'data');
  if (!Array.isArray(rows)) throw new TypeError('invalid catalog');
  const models = rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const value = Reflect.get(row, gemini ? 'name' : 'id');
    if (typeof value !== 'string' || value.trim() === '') return [];
    return [gemini ? value.replace(/^models\//u, '') : value];
  });
  return uniq(models);
}
