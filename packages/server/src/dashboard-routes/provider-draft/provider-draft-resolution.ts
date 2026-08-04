import { type DashboardProviderDraft, type Provider, ProviderKind, ProviderSchema } from '@aio-proxy/types';
import { isEqual, isPlainObject } from 'es-toolkit/predicate';

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
        | 'fresh_credentials_required';
    };

const OMIT = Symbol('redacted draft value');
const CREDENTIAL_FIELD_PATTERN = /(?:api[-_]?key|authorization|bearer|credential|password|secret|token)/i;
const CREDENTIAL_HEADER_PATTERN = /(?:^|-)(?:authorization|api-key)$/i;

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
  let previous: Provider | undefined;
  let identityChanged = false;

  if (persistedProviderId !== undefined) {
    if (persistedProviderId !== draft.id) return { ok: false, code: 'persisted_provider_mismatch' };
    previous = state.currentConfig().providers.find(({ id }) => id === persistedProviderId);
    if (previous === undefined) return { ok: false, code: 'persisted_provider_not_found' };
    if (previous.kind !== draft.kind) return { ok: false, code: 'persisted_provider_mismatch' };

    identityChanged = !hasSameProviderIdentity(previous, draft);
    if (identityChanged) {
      candidate = { ...(stripRedactedValues(normalizedDraft) as Record<string, unknown>), enabled: true };
    } else {
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
  if (identityChanged && previous !== undefined && requiresFreshCredentials(previous, parsed.data)) {
    return { ok: false, code: 'fresh_credentials_required' };
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
      isEqual(draft.options, redactSecrets(previous.options)) &&
      hasSameProxyIdentity(previous.proxy, draft.proxy)
    );
  }

  return false;
}

function hasSameProxyIdentity(previous: string | false | undefined, draft: string | false | null | undefined): boolean {
  const resolved = draft === undefined ? previous : draft === null ? undefined : draft;
  return resolved === previous;
}

function stripRedactedValues(value: unknown): unknown {
  if (typeof value === 'string' && value.includes('****')) return OMIT;
  if (Array.isArray(value)) return value.map(stripRedactedValues).filter((item) => item !== OMIT);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const sanitized = stripRedactedValues(item);
      return sanitized === OMIT ? [] : [[key, sanitized]];
    }),
  );
}

function requiresFreshCredentials(previous: Provider, candidate: Provider): boolean {
  const persisted = credentialFields(previous);
  return hasPersistedSensitiveValue(persisted) && !hasFreshCredentialValue(credentialFields(candidate));
}

function credentialFields(provider: Provider): unknown {
  if (provider.kind === ProviderKind.OAuth) return undefined;
  return provider.kind === ProviderKind.Api ? { apiKey: provider.apiKey, headers: provider.headers } : provider.options;
}

function hasPersistedSensitiveValue(value: unknown, key = '', insideSecretBoundary = false): boolean {
  if (typeof value === 'string') {
    return value.trim() !== '' && redactSecrets(value, key, insideSecretBoundary) !== value;
  }
  if (Array.isArray(value)) return value.some((item) => hasPersistedSensitiveValue(item, key, insideSecretBoundary));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([entryKey, item]) =>
    hasPersistedSensitiveValue(
      item,
      entryKey,
      insideSecretBoundary || entryKey.toLowerCase() === 'headers' || entryKey.toLowerCase() === 'proxy',
    ),
  );
}

function hasFreshCredentialValue(value: unknown, key = '', insideHeaders = false): boolean {
  if (typeof value === 'string') {
    const credentialPath = insideHeaders ? CREDENTIAL_HEADER_PATTERN.test(key) : CREDENTIAL_FIELD_PATTERN.test(key);
    return value.trim() !== '' && credentialPath;
  }
  if (Array.isArray(value)) return value.some((item) => hasFreshCredentialValue(item, key, insideHeaders));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([entryKey, item]) =>
    hasFreshCredentialValue(item, entryKey, insideHeaders || entryKey.toLowerCase() === 'headers'),
  );
}
