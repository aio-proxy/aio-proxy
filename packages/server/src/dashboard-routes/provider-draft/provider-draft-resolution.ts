import {
  apiProviderEndpoints,
  type DashboardProviderDraft,
  type Provider,
  ProviderKind,
  ProviderSchema,
} from '@aio-proxy/types';
import { isEqual } from 'es-toolkit/predicate';

import type { ServerState } from '../../server-state';
import { replaceOAuthProvider, replaceProvider } from '../provider-mutation';

type DraftResolution =
  | { readonly ok: true; readonly provider: Provider }
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
  let previous: Provider | undefined;

  if (persistedProviderId !== undefined) {
    if (persistedProviderId !== draft.id) return { ok: false, code: 'persisted_provider_mismatch' };
    previous = state.currentConfig().providers.find(({ id }) => id === persistedProviderId);
    if (previous === undefined) return { ok: false, code: 'persisted_provider_not_found' };
    if (previous.kind !== draft.kind) return { ok: false, code: 'persisted_provider_mismatch' };

    if (hasSameProviderIdentity(previous, draft)) {
      const { id: _previousId, ...previousBody } = previous;
      const { id: _draftId, ...draftBody } = normalizedDraft;
      const merge = draft.kind === ProviderKind.OAuth ? replaceOAuthProvider : replaceProvider;
      const restored = merge({ [persistedProviderId]: previousBody }, persistedProviderId, draftBody)[
        persistedProviderId
      ];
      if (inheritsProxy && typeof restored === 'object' && restored !== null) {
        delete (restored as Record<string, unknown>)['proxy'];
      }
      candidate = { ...(restored as Record<string, unknown>), enabled: true, id: draft.id };
    } else {
      // Destination/proxy/options changed. The edit-view preloads stored secrets into the
      // draft, so treat those retained values as absent and keep only freshly typed ones.
      candidate = { ...stripRetainedSecrets(previous, normalizedDraft), enabled: true };
      if (inheritsProxy) {
        delete (candidate as Record<string, unknown>)['proxy'];
      }
    }
  }

  const parsed = ProviderSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: 'persisted_provider_mismatch' };
  // An oauth draft is only testable against its persisted account; a fresh
  // oauth draft has no credentials and never will (fresh_credentials_required
  // does not apply — oauth drafts carry no credential fields at all).
  if (parsed.data.kind === ProviderKind.OAuth && previous?.kind !== ProviderKind.OAuth) {
    return { ok: false, code: 'persisted_provider_mismatch' };
  }
  return { ok: true, provider: parsed.data };
}

function hasSameProviderIdentity(previous: Provider, draft: DashboardProviderDraft): boolean {
  if (previous.kind === ProviderKind.Api && draft.kind === ProviderKind.Api) {
    return sameApiDestinations(previous, draft) && hasSameProxyIdentity(previous.proxy, draft.proxy);
  }

  if (previous.kind === ProviderKind.AiSdk && draft.kind === ProviderKind.AiSdk) {
    const packageName = draft.packageName ?? '@ai-sdk/openai-compatible';
    return (
      previous.packageName === packageName &&
      isEqual(draft.options, previous.options) &&
      hasSameProxyIdentity(previous.proxy, draft.proxy)
    );
  }

  // OAuth drafts cannot edit plugin/capability, so connection identity never changes.
  if (previous.kind === ProviderKind.OAuth && draft.kind === ProviderKind.OAuth) {
    return true;
  }

  return false;
}

function sameApiDestinations(previous: Provider, draft: DashboardProviderDraft): boolean {
  if (previous.kind !== ProviderKind.Api || draft.kind !== ProviderKind.Api) return false;
  try {
    const previousEndpoints = apiProviderEndpoints(previous);
    const draftEndpoints = apiProviderEndpoints(draft);
    if (previousEndpoints.length !== draftEndpoints.length) return false;
    return previousEndpoints.every(
      (endpoint, index) =>
        endpoint.protocol === draftEndpoints[index]?.protocol && endpoint.baseURL === draftEndpoints[index]?.baseURL,
    );
  } catch {
    return (
      previous.protocol === draft.protocol &&
      previous.baseURL === draft.baseURL &&
      isEqual(previous.endpoints, draft.endpoints)
    );
  }
}

function hasSameProxyIdentity(previous: string | false | undefined, draft: string | false | null | undefined): boolean {
  let resolved: string | false | undefined;
  if (draft === undefined) resolved = previous;
  else if (draft !== null) resolved = draft;
  return resolved === previous;
}

function stripRetainedSecrets(previous: Provider, draft: DashboardProviderDraft): DashboardProviderDraft {
  return stripMatchingSecrets(draft, previous, retainedSecretValues(previous)) as DashboardProviderDraft;
}

function retainedSecretValues(previous: Provider): ReadonlySet<string> {
  const values = new Set<string>();
  collectSecretValues(previous, values);
  return values;
}

function collectSecretValues(value: unknown, values: Set<string>, key = '', sensitive = false): void {
  const nestedSensitive = sensitive || isSensitiveDraftKey(key);
  if (typeof value === 'string') {
    if (nestedSensitive) values.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecretValues(item, values, key, nestedSensitive);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      collectSecretValues(entryValue, values, entryKey, nestedSensitive);
    }
  }
}

function stripMatchingSecrets(
  submitted: unknown,
  previous: unknown,
  retained: ReadonlySet<string>,
  key = '',
  sensitive = false,
): unknown {
  const nestedSensitive = sensitive || isSensitiveDraftKey(key);
  if (typeof submitted === 'string') {
    if (!nestedSensitive) return submitted;
    return submitted === previous || retained.has(submitted) ? undefined : submitted;
  }
  if (Array.isArray(submitted)) {
    const previousItems = Array.isArray(previous) ? previous : [];
    return submitted.map((value, index) =>
      stripMatchingSecrets(value, previousItems[index], retained, key, nestedSensitive),
    );
  }
  if (submitted !== null && typeof submitted === 'object') {
    const previousRecord =
      previous !== null && typeof previous === 'object' ? (previous as Record<string, unknown>) : {};
    const next: Record<string, unknown> = {};
    for (const [entryKey, value] of Object.entries(submitted as Record<string, unknown>)) {
      const stripped = stripMatchingSecrets(value, previousRecord[entryKey], retained, entryKey, nestedSensitive);
      if (stripped !== undefined) next[entryKey] = stripped;
    }
    return next;
  }
  return submitted;
}

function isSensitiveDraftKey(key: string): boolean {
  return /(?:api[-_]?key|authorization|bearer|credential|password|secret|token|headers|proxy)/i.test(key);
}
