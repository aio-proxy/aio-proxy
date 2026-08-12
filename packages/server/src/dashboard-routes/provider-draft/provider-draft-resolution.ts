import { type DashboardProviderDraft, type Provider, ProviderKind, ProviderSchema } from '@aio-proxy/types';
import { isEqual } from 'es-toolkit/predicate';

import type { ServerState } from '../../server-state';
import { replaceProvider } from '../provider-mutation';

type DraftResolution =
  | { readonly ok: true; readonly provider: Exclude<Provider, { kind: ProviderKind.OAuth }> }
  | {
      readonly ok: false;
      readonly code: 'persisted_provider_not_found' | 'persisted_provider_mismatch';
    };

export function resolveProviderDraft(
  state: ServerState,
  draft: DashboardProviderDraft,
  persistedProviderId?: string,
): DraftResolution {
  const inheritsProxy = draft.proxy === null;
  const { proxy: _proxy, ...draftWithoutProxy } = draft;
  const normalizedDraft = inheritsProxy ? draftWithoutProxy : draft;
  let candidate: unknown = { ...normalizedDraft, enabled: true };

  if (persistedProviderId !== undefined) {
    if (persistedProviderId !== draft.id) return { ok: false, code: 'persisted_provider_mismatch' };
    const previous = state.currentConfig().providers.find(({ id }) => id === persistedProviderId);
    if (previous === undefined) return { ok: false, code: 'persisted_provider_not_found' };
    if (previous.kind !== draft.kind) return { ok: false, code: 'persisted_provider_mismatch' };

    if (hasSameProviderIdentity(previous, draft)) {
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
  }

  const parsed = ProviderSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.kind === ProviderKind.OAuth) {
    return { ok: false, code: 'persisted_provider_mismatch' };
  }
  return { ok: true, provider: parsed.data };
}

function hasSameProviderIdentity(previous: Provider, draft: DashboardProviderDraft): boolean {
  if (previous.kind === ProviderKind.Api && draft.kind === ProviderKind.Api) {
    return (
      previous.protocol === draft.protocol &&
      previous.baseURL === draft.baseURL &&
      hasSameProxyIdentity(previous.proxy, draft.proxy)
    );
  }

  if (previous.kind === ProviderKind.AiSdk && draft.kind === ProviderKind.AiSdk) {
    const packageName = draft.packageName ?? '@ai-sdk/openai-compatible';
    return (
      previous.packageName === packageName &&
      isEqual(draft.options, previous.options) &&
      hasSameProxyIdentity(previous.proxy, draft.proxy)
    );
  }

  return false;
}

function hasSameProxyIdentity(previous: string | false | undefined, draft: string | false | null | undefined): boolean {
  let resolved: string | false | undefined;
  if (draft === undefined) resolved = previous;
  else if (draft !== null) resolved = draft;
  return resolved === previous;
}
