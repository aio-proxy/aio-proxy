import { expect } from 'bun:test';

import type { OAuthLoginContext, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

export const DISCOVERY = 'https://auth.x.ai/.well-known/openid-configuration';
export const DEVICE = 'https://auth.x.ai/oauth2/device/code';
export const TOKEN = 'https://auth.x.ai/oauth2/token';

export function loginContext(presented: unknown[]): OAuthLoginContext {
  return {
    authorization: {
      presentDeviceCode: async (input) => {
        presented.push(input);
      },
      presentAuthorizeUrl: async () => {},
      loopback: async () => {
        throw new Error('device flow must not use loopback');
      },
    },
    progress: () => {},
    signal: new AbortController().signal,
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

export function jwt(payload: object): string {
  return ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');
}
