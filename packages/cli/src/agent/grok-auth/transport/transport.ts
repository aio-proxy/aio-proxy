import { setTimeout } from 'node:timers/promises';

import {
  pollDeviceAuthorization,
  refreshAgentCredential,
  requestDeviceAuthorization,
  type AgentRuntimeRequestOptions,
} from '@aio-proxy/agent-provider-runtime';

import type { GrokDeadline, GrokMarker } from '../../grok';
import type { GrokTransport } from '../types';

export function createGrokTransport(
  marker: GrokMarker,
  budget: GrokDeadline,
  options?: { readonly fetch?: typeof globalThis.fetch; readonly now?: () => number },
): GrokTransport {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const now = options?.now ?? Date.now;
  const safeFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(marker.endpoint).origin || url.username !== '' || url.password !== '') {
      throw new Error('OAuth destination rejected');
    }
    budget.signal.throwIfAborted();
    const response = await fetchImpl(input, {
      ...init,
      redirect: 'manual',
      signal: budget.signal,
    });
    if (response.status >= 300 && response.status < 400) throw new Error('OAuth redirect rejected');
    return response;
  };
  const runtimeOptions: AgentRuntimeRequestOptions = {
    fetch: safeFetch as typeof globalThis.fetch,
    signal: budget.signal,
    now,
    sleep: (milliseconds) => setTimeout(milliseconds, undefined, { signal: budget.signal }),
  };
  return {
    device: (requestMarker) => requestDeviceAuthorization(requestMarker, runtimeOptions),
    poll: (requestMarker, device) => pollDeviceAuthorization(requestMarker, device, runtimeOptions),
    refresh: (requestMarker, refreshToken) => refreshAgentCredential(requestMarker, refreshToken, runtimeOptions),
  };
}
