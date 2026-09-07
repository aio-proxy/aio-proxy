import { expect } from 'bun:test';

import type { OAuthLoginContext, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

export const DEVICE = 'https://auth.meta.com/oidc/device/authorization/';
export const TOKEN = 'https://auth.meta.com/oidc/device/token/';
export const KEY = 'https://api.meta.ai/muse-code/key';

export function loginContext(
  presented: unknown[],
  progress: unknown[] = [],
  signal: AbortSignal = new AbortController().signal,
): OAuthLoginContext {
  return {
    authorization: {
      presentDeviceCode: async (input) => {
        presented.push(input);
      },
      presentAuthorizeUrl: async () => {},
      loopback: async () => {
        throw new Error('Muse Code must not use loopback');
      },
    },
    progress: (message) => progress.push(message),
    signal,
  };
}

export function sequenceFetch(requests: Request[], responses: Response[]): RuntimeFetch {
  return async (input, init) => {
    expect((init as RuntimeRequestInit | undefined)?.aioProxy).toEqual({ traffic: 'control' });
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (response === undefined) throw new Error('unexpected request');
    return response;
  };
}
