import {
  apiProviderEndpoints,
  type DashboardProviderDraftCatalogResponse,
  type DashboardProviderDraftTestResponse,
  type Provider,
  ProviderKind,
  ProviderProtocol,
  ProviderSchema,
} from '@aio-proxy/types';

import { oauthExposedModels } from '../../plugin-runtime';
import { discoverProviderModels } from '../../provider-model-discovery';
import { materializeProviders } from '../../provider-runtime';
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
  const discovery = await discoverProviderModels(state.currentConfig(), provider, AbortSignal.timeout(5_000), {
    strict: false,
  });
  return discovery.ok ? discovery : failure(discovery.code);
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
  const runtime = materializeDraft(state, provider);
  const instance = runtime.providers[0];
  const probe = runtime.probes.get(provider.id);
  if (instance === undefined || probe === undefined) throw new Error('draft provider materialization failed');
  return { provider: instance, probe };
}

function materializeDraft(state: ServerState, provider: Exclude<Provider, { kind: ProviderKind.OAuth }>) {
  return materializeProviders({ ...state.currentConfig(), invalidProviders: [], providers: [provider] });
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
