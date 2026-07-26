import type { OAuthLoginContext } from '@aio-proxy/plugin-sdk';

export const DISCOVERY = 'https://auth.x.ai/.well-known/openid-configuration';
export const DEVICE = 'https://auth.x.ai/oauth2/device/code';
export const TOKEN = 'https://auth.x.ai/oauth2/token';

export function loginContext(presented: unknown[]): OAuthLoginContext {
  return {
    authorization: {
      presentDeviceCode: async (input) => {
        presented.push(input);
      },
      loopback: async () => {
        throw new Error('device flow must not use loopback');
      },
    },
    progress: () => {},
    signal: new AbortController().signal,
  };
}

export function sequenceFetch(requests: Request[], responses: Response[]): typeof fetch {
  return async (input, init) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (response === undefined) throw new Error('unexpected request');
    return response;
  };
}

export function jwt(payload: object): string {
  return ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');
}
