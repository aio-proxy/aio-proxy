import type { RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

export type RuntimeFetchInput = {
  readonly control: typeof globalThis.fetch;
  readonly model: typeof globalThis.fetch;
};

export function createRuntimeFetch(input: RuntimeFetchInput): RuntimeFetch {
  const fetch = async (request: RequestInfo | URL, init?: RuntimeRequestInit): Promise<Response> => {
    const traffic = init?.aioProxy?.traffic ?? 'model';
    if (traffic !== 'model' && traffic !== 'control') throw new TypeError('Invalid aio-proxy fetch traffic');
    const forwarded = stripAioProxy(init);
    return await (traffic === 'control' ? input.control : input.model)(request, forwarded);
  };
  return Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }) as RuntimeFetch;
}

function stripAioProxy(init: RuntimeRequestInit | undefined): RequestInit | undefined {
  if (init === undefined) return undefined;
  const { aioProxy: _aioProxy, ...forwarded } = init;
  return forwarded;
}
