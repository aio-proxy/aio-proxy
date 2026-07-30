import type { Provider } from '@aio-proxy/types';

import { currentProviderAttemptContext } from '../request-logging';
import { compileProviderRequestTransforms } from './compile';
import { ProviderRequestTransformError, type ProviderRequestTransformLocation } from './error';
import {
  evaluateProviderRequestTransforms,
  type ProviderRequestTransformJson,
  type ProviderRequestTransformResult,
} from './evaluate';

type BunFetchInit = RequestInit & { readonly decompress?: boolean };

const CONNECTION_MANAGED_HEADERS = [
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
] as const;

export function createProviderRequestTransformFetch(
  provider: Provider,
  fetcher: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const compiled = compileProviderRequestTransforms(provider.transforms?.request ?? []);
  if (compiled.rules.length === 0) return fetcher;

  return (async (input, init) => {
    const attempt = currentProviderAttemptContext();
    if (attempt === undefined || attempt.providerId !== provider.id) return fetcher(input, init);

    let request: Request;
    try {
      request = new Request(input, init);
    } catch {
      throw rebuildError();
    }
    const headers = Object.fromEntries([...request.headers].map(([name, value]) => [name.toLowerCase(), value]));
    let body: Promise<ProviderRequestTransformJson> | undefined;
    const result = await evaluateProviderRequestTransforms(
      compiled,
      {
        provider: {
          id: provider.id,
          kind: provider.kind,
          ...('protocol' in provider ? { protocol: provider.protocol } : {}),
        },
        request: {
          model: attempt.modelId,
          requestedModel: attempt.requestedModelId,
          sourceProtocol: attempt.sourceProtocol,
          ...(attempt.targetProtocol === undefined ? {} : { targetProtocol: attempt.targetProtocol }),
          method: request.method,
          url: request.url,
          headers,
        },
      },
      (location) => (body ??= loadJsonBody(request, location)),
    );
    const transformed = rebuildRequest(request, result);
    const decompress = (init as BunFetchInit | undefined)?.decompress;
    return fetcher(transformed, decompress === undefined ? undefined : { decompress });
  }) as typeof globalThis.fetch;
}

async function loadJsonBody(
  request: Request,
  location: ProviderRequestTransformLocation,
): Promise<ProviderRequestTransformJson> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === undefined || (mediaType !== 'application/json' && !mediaType.endsWith('+json'))) {
    throw new ProviderRequestTransformError({ code: 'REQUEST_TRANSFORM_BODY_NOT_JSON', ...location });
  }
  try {
    return JSON.parse(await request.clone().text()) as ProviderRequestTransformJson;
  } catch {
    throw new ProviderRequestTransformError({ code: 'REQUEST_TRANSFORM_BODY_PARSE_FAILED', ...location });
  }
}

function rebuildRequest(request: Request, result: ProviderRequestTransformResult): Request {
  try {
    const headers = new Headers(result.request.headers as HeadersInit);
    for (const name of CONNECTION_MANAGED_HEADERS) {
      if (request.headers.get(name) === headers.get(name)) continue;
      const location = result.headerWriteLocations.get(name);
      throw new ProviderRequestTransformError({
        code: 'REQUEST_TRANSFORM_HEADER_FORBIDDEN',
        ...(location === undefined ? {} : location),
      });
    }
    if (result.bodyModified) headers.delete('content-length');

    const serializedBody = result.bodyModified ? JSON.stringify(result.request.body) : undefined;
    return new Request(request.url, {
      cache: request.cache,
      credentials: request.credentials,
      headers,
      integrity: request.integrity,
      keepalive: request.keepalive,
      method: request.method,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      signal: request.signal,
      ...(result.bodyModified
        ? serializedBody === undefined
          ? {}
          : { body: serializedBody }
        : request.body === null
          ? {}
          : { body: request.body }),
    });
  } catch (error) {
    if (error instanceof ProviderRequestTransformError) throw error;
    throw rebuildError(result.lastAppliedLocation);
  }
}

function rebuildError(location?: ProviderRequestTransformLocation): ProviderRequestTransformError {
  return new ProviderRequestTransformError({
    code: 'REQUEST_TRANSFORM_REQUEST_REBUILD_FAILED',
    ...(location === undefined ? {} : location),
  });
}
