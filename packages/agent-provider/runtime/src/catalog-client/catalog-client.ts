import {
  AgentCatalogErrorSchema,
  AgentCatalogV1Schema,
  type AgentAdapterFailure,
  type AgentCatalogV1,
  type AgentManagedMarker,
} from '@aio-proxy/types';

import { readManagedState, writeManagedState } from '../managed-state';
import type { AgentRuntimeRequestOptions } from '../oauth-client';

export type RefreshCatalogInput = AgentRuntimeRequestOptions & {
  readonly marker: AgentManagedMarker;
  readonly statePath: string;
  readonly accessToken: string;
};

export type RefreshCatalogResult = {
  readonly catalog: AgentCatalogV1 | null;
  readonly source: 'network' | 'lkg' | 'missing';
  readonly status: 'fresh' | 'stale' | 'missing';
  readonly error?: AgentAdapterFailure;
};

export const CATALOG_REFRESH_INTERVAL_MS = 300_000;

export async function refreshAgentCatalog(input: RefreshCatalogInput): Promise<RefreshCatalogResult> {
  const url = new URL('/v1/models', input.marker.endpoint);
  url.search = new URLSearchParams({
    agent: input.marker.agent,
    adapter_version: input.marker.adapterVersion,
    schema_version: '1',
  }).toString();
  const fetcher = input.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    throwIfAborted(input.signal);
    return preserveLkg(input, 'network');
  }
  if (response.status === 401) return preserveLkg(input, 'unauthorized');
  if (response.status === 400) {
    const error = AgentCatalogErrorSchema.safeParse(await response.json().catch(() => null));
    if (error.success && error.data.error.code === 'unsupported_schema')
      return preserveLkg(input, 'unsupported_schema');
  }
  if (!response.ok) return preserveLkg(input, 'server_error');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throwIfAborted(input.signal);
    return preserveLkg(input, 'invalid_json');
  }
  const parsed = AgentCatalogV1Schema.safeParse(body);
  if (!parsed.success || parsed.data.agent !== input.marker.agent) return preserveLkg(input, 'invalid_catalog');
  const timestamp = new Date((input.now ?? Date.now)()).toISOString();
  await writeManagedState(input.statePath, {
    format: 1,
    catalogSchema: 1,
    status: 'fresh',
    lastSuccessfulAt: timestamp,
    lastError: null,
    lkg: parsed.data,
  });
  return { catalog: parsed.data, source: 'network', status: 'fresh' };
}

async function preserveLkg(input: RefreshCatalogInput, error: AgentAdapterFailure): Promise<RefreshCatalogResult> {
  const previous = await readManagedState(input.statePath);
  const lkg = previous?.lkg?.agent === input.marker.agent ? previous.lkg : null;
  if (lkg !== null) {
    await writeManagedState(input.statePath, {
      ...previous!,
      status: 'stale',
      lastError: error,
      lkg,
    });
    return { catalog: lkg, source: 'lkg', status: 'stale', error };
  }
  await writeManagedState(input.statePath, {
    format: 1,
    catalogSchema: 1,
    status: 'missing',
    lastSuccessfulAt: null,
    lastError: error,
    lkg: null,
  });
  return { catalog: null, source: 'missing', status: 'missing', error };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}
