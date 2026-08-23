import type { ApiEndpointsInput, ProviderEndpointAuth, ProviderProtocol } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';

import { usableBaseURL } from '../section-status/usable-base-url';

export type ApiEndpointDraftProtocol = ProviderProtocol | '';

export type ApiEndpointDraft =
  | {
      readonly shape: 'shared';
      readonly baseURL: string;
      readonly protocols: readonly ProviderProtocol[];
    }
  | {
      readonly shape: 'separate';
      readonly entries: readonly {
        readonly protocol: ApiEndpointDraftProtocol;
        readonly baseURL: string;
        readonly auth?: ProviderEndpointAuth;
      }[];
    };

export type ApiConnectionIssue = 'missing' | 'bad-url' | 'bearer-key';

export const emptySharedDraft = (): ApiEndpointDraft => ({ shape: 'shared', baseURL: '', protocols: [] });

const concreteProtocols = (value: unknown): ProviderProtocol[] =>
  Array.isArray(value) ? value.filter((item): item is ProviderProtocol => typeof item === 'string' && item !== '') : [];

export function apiDraftFromProvider(value: {
  readonly kind?: unknown;
  readonly protocol?: unknown;
  readonly baseURL?: unknown;
  readonly endpoints?: unknown;
}): ApiEndpointDraft | undefined {
  if (value.kind !== ProviderKind.Api) return undefined;
  const endpoints = value.endpoints;
  if (endpoints !== undefined && !Array.isArray(endpoints) && typeof endpoints === 'object' && endpoints !== null) {
    const shared = endpoints as { readonly baseURL?: unknown; readonly protocol?: unknown };
    if (typeof shared.baseURL === 'string' && Array.isArray(shared.protocol)) {
      return { shape: 'shared', baseURL: shared.baseURL, protocols: concreteProtocols(shared.protocol) };
    }
  }
  const rows: Extract<ApiEndpointDraft, { shape: 'separate' }>['entries'][number][] = [];
  if (typeof value.protocol === 'string' && typeof value.baseURL === 'string') {
    rows.push({ protocol: value.protocol as ProviderProtocol, baseURL: value.baseURL });
  }
  if (Array.isArray(endpoints)) {
    for (const entry of endpoints) {
      if (entry === null || typeof entry !== 'object') continue;
      const protocol = 'protocol' in entry && typeof entry.protocol === 'string' ? entry.protocol : '';
      const baseURL = 'baseURL' in entry && typeof entry.baseURL === 'string' ? entry.baseURL : '';
      const auth = 'auth' in entry && (entry.auth === 'bearer' || entry.auth === 'x-api-key') ? entry.auth : undefined;
      rows.push({ protocol: protocol as ApiEndpointDraftProtocol, baseURL, ...(auth === undefined ? {} : { auth }) });
    }
  }
  if (rows.length === 0) return emptySharedDraft();
  if (rows.length === 1 && rows[0] !== undefined && !Array.isArray(endpoints)) {
    const only = rows[0];
    if (only.protocol === '') return emptySharedDraft();
    return { shape: 'shared', baseURL: only.baseURL, protocols: [only.protocol] };
  }
  // A stored legacy protocol/baseURL pair is origin-mode. Keep it as a separate
  // first row even when extra endpoints reuse the same URL, so a save does not
  // collapse the pair into shared SDK-mode endpoints.
  if (typeof value.protocol === 'string' && typeof value.baseURL === 'string' && Array.isArray(endpoints)) {
    return { shape: 'separate', entries: rows };
  }
  const urls = new Set(rows.map((row) => row.baseURL.trim()));
  const hasSpecialAuth = rows.some((row) => row.auth !== undefined && row.auth !== 'x-api-key');
  if (urls.size === 1 && !hasSpecialAuth && rows.every((row) => row.protocol !== '')) {
    return {
      shape: 'shared',
      baseURL: rows[0]?.baseURL ?? '',
      protocols: rows.map((row) => row.protocol as ProviderProtocol),
    };
  }
  return { shape: 'separate', entries: rows };
}

export function apiDraftToMutation(draft: ApiEndpointDraft): {
  readonly protocol?: ProviderProtocol;
  readonly baseURL?: string;
  readonly endpoints?: ApiEndpointsInput;
} {
  if (draft.shape === 'shared') {
    const [only, ...rest] = draft.protocols;
    if (only !== undefined && rest.length === 0) return { protocol: only, baseURL: draft.baseURL };
    if (only === undefined) return {};
    return { endpoints: { baseURL: draft.baseURL, protocol: [...draft.protocols] } };
  }
  const entries = draft.entries.flatMap((entry) => {
    if (entry.protocol === '' || entry.baseURL.trim() === '') return [];
    return [
      {
        protocol: entry.protocol,
        baseURL: entry.baseURL,
        ...(entry.auth === undefined || entry.auth === 'x-api-key' ? {} : { auth: entry.auth }),
      },
    ];
  });
  return entries.length === 0 ? {} : { endpoints: entries as ApiEndpointsInput };
}

export const sharedConversionIssue = (
  entries: Extract<ApiEndpointDraft, { shape: 'separate' }>['entries'],
): 'dashboard.providers.form.endpoints_shared_conversion_blocked' | undefined => {
  const baseURL = entries[0]?.baseURL.trim();
  return entries.some(
    (entry) => entry.baseURL.trim() !== baseURL || (entry.auth !== undefined && entry.auth !== 'x-api-key'),
  )
    ? 'dashboard.providers.form.endpoints_shared_conversion_blocked'
    : undefined;
};

export function switchApiEndpointShape(draft: ApiEndpointDraft, shape: ApiEndpointDraft['shape']): ApiEndpointDraft {
  if (draft.shape === shape) return draft;
  if (shape === 'separate') {
    if (draft.shape !== 'shared') return draft;
    const entries = draft.protocols.map((protocol) => ({ protocol, baseURL: draft.baseURL }));
    return {
      shape: 'separate',
      entries: entries.length === 0 ? [{ protocol: '', baseURL: draft.baseURL }] : entries,
    };
  }
  if (draft.shape !== 'separate' || sharedConversionIssue(draft.entries) !== undefined) return draft;
  return {
    shape: 'shared',
    baseURL: draft.entries[0]?.baseURL ?? '',
    protocols: draft.entries.flatMap((entry) => (entry.protocol === '' ? [] : [entry.protocol])),
  };
}

export function apiConnectionIssues(
  draft: ApiEndpointDraft | undefined,
  credentials: { readonly apiKey: string; readonly hasApiKey: boolean },
): ApiConnectionIssue | undefined {
  const current = draft ?? emptySharedDraft();
  if (current.shape === 'shared') {
    const trimmed = current.baseURL.trim();
    if (trimmed === '' || current.protocols.length === 0) return 'missing';
    if (!usableBaseURL(trimmed)) return 'bad-url';
    return undefined;
  }
  if (current.entries.length === 0) return 'missing';
  for (const entry of current.entries) {
    const trimmed = entry.baseURL.trim();
    if (entry.protocol === '' || trimmed === '') return 'missing';
    if (!usableBaseURL(trimmed)) return 'bad-url';
    if (
      entry.protocol === 'anthropic' &&
      entry.auth === 'bearer' &&
      !credentials.hasApiKey &&
      credentials.apiKey.trim() === ''
    ) {
      return 'bearer-key';
    }
  }
  return undefined;
}
