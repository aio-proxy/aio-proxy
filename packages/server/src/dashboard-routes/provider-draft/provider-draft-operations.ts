import {
  type DashboardProviderDraft,
  type DashboardProviderDraftCatalogResponse,
  type DashboardProviderDraftTestResponse,
  type Provider,
  ProviderKind,
  ProviderProtocol,
  ProviderSchema,
} from '@aio-proxy/types';
import { isEqual } from 'es-toolkit/predicate';

import { materializeProviders } from '../../provider-runtime';
import { withAttemptLogContext, withRequestLogContext } from '../../request-logging';
import type { RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';
import { replaceProvider } from '../provider-mutation';
import { redactSecrets } from '../provider-secrets';

type DraftResolution =
  | { readonly ok: true; readonly provider: Exclude<Provider, { kind: ProviderKind.OAuth }> }
  | {
      readonly ok: false;
      readonly code:
        | 'redacted_proxy_unsupported'
        | 'persisted_provider_not_found'
        | 'persisted_provider_mismatch'
        | 'persisted_provider_identity_mismatch';
    };

const failure = <Code extends string>(code: Code) => ({
  ok: false as const,
  error: { code, recoverable: true as const },
});

export function resolveProviderDraft(
  state: ServerState,
  draft: DashboardProviderDraft,
  persistedProviderId?: string,
): DraftResolution {
  if (draft.proxy === '****') return { ok: false, code: 'redacted_proxy_unsupported' };

  const inheritsProxy = draft.proxy === null;
  const { proxy: _proxy, ...draftWithoutProxy } = draft;
  const normalizedDraft = inheritsProxy ? draftWithoutProxy : draft;
  let candidate: unknown = { ...normalizedDraft, enabled: true };
  if (persistedProviderId !== undefined) {
    if (persistedProviderId !== draft.id) return { ok: false, code: 'persisted_provider_mismatch' };
    const previous = state.currentConfig().providers.find(({ id }) => id === persistedProviderId);
    if (previous === undefined) return { ok: false, code: 'persisted_provider_not_found' };
    if (previous.kind !== draft.kind) {
      return { ok: false, code: 'persisted_provider_mismatch' };
    }
    if (!hasSameProviderIdentity(previous, draft)) {
      return { ok: false, code: 'persisted_provider_identity_mismatch' };
    }
    const { id: _previousId, ...previousBody } = previous;
    const { id: _draftId, ...draftBody } = normalizedDraft;
    const restored = replaceProvider({ [persistedProviderId]: previousBody }, persistedProviderId, draftBody)[
      persistedProviderId
    ];
    if (inheritsProxy && typeof restored === 'object' && restored !== null) {
      delete (restored as Record<string, unknown>)['proxy'];
    }
    candidate = { ...(restored as Record<string, unknown>), enabled: true, id: draft.id };
  }

  const parsed = ProviderSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.kind === ProviderKind.OAuth) {
    return { ok: false, code: 'persisted_provider_mismatch' };
  }
  return { ok: true, provider: parsed.data };
}

function hasSameProviderIdentity(previous: Provider, draft: DashboardProviderDraft): boolean {
  if (previous.kind === ProviderKind.Api && draft.kind === ProviderKind.Api) {
    return previous.protocol === draft.protocol && previous.baseURL === draft.baseURL;
  }

  if (previous.kind === ProviderKind.AiSdk && draft.kind === ProviderKind.AiSdk) {
    const packageName = draft.packageName ?? '@ai-sdk/openai-compatible';
    return previous.packageName === packageName && isEqual(draft.options, redactSecrets(previous.options));
  }

  return false;
}

export async function loadProviderDraftCatalog(
  state: ServerState,
  provider: Exclude<Provider, { kind: ProviderKind.OAuth }>,
): Promise<DashboardProviderDraftCatalogResponse> {
  if (provider.kind === ProviderKind.AiSdk) return failure('catalog_unsupported');

  try {
    const runtime = materializeDraft(state, provider);
    const raw = runtime.raw?.resolve({ protocol: provider.protocol, modelId: '' });
    if (raw === undefined) return failure('catalog_unavailable');
    const response = await raw.invoke(
      new Request(`http://provider-draft.invalid${catalogPath(provider.protocol)}`, {
        signal: AbortSignal.timeout(5_000),
      }),
      undefined,
      { upstreamStream: false },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return failure('catalog_unavailable');
    }
    return { ok: true, models: catalogModels(provider.protocol, await response.json()) };
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
