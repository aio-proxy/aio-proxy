import type { RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

export const MUSE_API_VERSION = '1.0.0';

export class MuseCodeHttpError extends Error {
  override readonly name = 'MuseCodeHttpError';
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function museControlHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('Accept', 'application/json');
  headers.set('x-api-version', MUSE_API_VERSION);
  return headers;
}

export async function museControlFetch(fetcher: RuntimeFetch, input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(input, { ...init, aioProxy: { traffic: 'control' } } as RuntimeRequestInit);
  } catch {
    if (init.signal?.aborted) throw init.signal.reason;
    throw new MuseCodeHttpError('Muse Code request failed', true);
  }
}

export async function museControlReadText(response: Response, signal?: AbortSignal): Promise<string> {
  try {
    return await response.text();
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new MuseCodeHttpError('Muse Code request failed', true);
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
