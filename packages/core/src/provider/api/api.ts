import type { RawTransportOptions } from '@aio-proxy/plugin-sdk';
import { type ApiProvider, apiProviderEndpoints, type NormalizedApiEndpoint, ProviderProtocol } from '@aio-proxy/types';

import { wrapOpenAIProtocolFetch } from '../openai-stream-fetch';
import type { ProviderFetch } from '../proxy-fetch';

declare const process: {
  readonly env: Record<string, string | undefined>;
};

export type ApiProviderTrace = {
  readonly bodySha256: string;
  readonly category?: 'rate_limit';
  readonly status: number;
};

export type ApiProviderTraceSink = {
  readonly record: (entry: ApiProviderTrace) => void;
};

type ApiProviderTraceTarget = ApiProviderTraceSink | ApiProviderTrace[];

const CLIENT_CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-goog-api-key',
] as const;

export type ApiProviderConfig = ApiProvider & { readonly trace?: ApiProviderTraceTarget };

export type ApiEndpointTransport = {
  readonly protocol: ProviderProtocol;
  readonly passthrough: (req: Request, options?: RawTransportOptions) => Promise<Response>;
};

export type ApiProviderInstance = ApiProvider & {
  readonly endpointTransports: readonly [ApiEndpointTransport, ...ApiEndpointTransport[]];
  /** Primary-endpoint passthrough; equals endpointTransports[0].passthrough. */
  readonly passthrough: (req: Request, options?: RawTransportOptions) => Promise<Response>;
};

export type ApiProviderFactoryOptions = {
  readonly trace?: ApiProviderTraceTarget;
  /** Injected by provider materialization to route upstream calls through the effective proxy. Wired in Tasks 5–6. */
  readonly fetch?: ProviderFetch;
};

export function createApiProvider(
  config: ApiProviderConfig,
  options: ApiProviderFactoryOptions = {},
): ApiProviderInstance {
  const trace = options.trace ?? config.trace;
  const fetcher = options.fetch ?? globalThis.fetch;
  const endpoints = apiProviderEndpoints(config);
  const primary = endpointTransport(endpoints[0], config, fetcher, trace);
  const rest = endpoints.slice(1).map((endpoint) => endpointTransport(endpoint, config, fetcher, trace));
  const { trace: _trace, ...providerFields } = config;
  return { ...providerFields, endpointTransports: [primary, ...rest], passthrough: primary.passthrough };
}

const SDK_VERSION_PREFIXES: Record<ProviderProtocol, string> = {
  [ProviderProtocol.OpenAIResponse]: '/v1',
  [ProviderProtocol.OpenAICompatible]: '/v1',
  [ProviderProtocol.Anthropic]: '/v1',
  [ProviderProtocol.Gemini]: '/v1beta',
  [ProviderProtocol.GeminiInteractions]: '/v1beta',
  [ProviderProtocol.OpenAIImage]: '/v1',
};

function endpointTransport(
  endpoint: NormalizedApiEndpoint,
  config: Pick<ApiProviderConfig, 'apiKey' | 'headers'>,
  fetcher: ProviderFetch,
  trace: ApiProviderTraceTarget | undefined,
): ApiEndpointTransport {
  const fetchUpstream = wrapOpenAIProtocolFetch(endpoint.protocol, fetcher);
  return {
    protocol: endpoint.protocol,
    async passthrough(req, options) {
      const upstreamUrl =
        endpoint.mode === 'origin'
          ? rewrittenUrl(endpoint.baseURL, req.url)
          : sdkRewrittenUrl(endpoint.baseURL, req.url, endpoint.protocol);
      const headers = upstreamHeaders(req.headers, config, endpoint);

      const response = await fetchUpstream(
        upstreamUrl,
        { body: req.body, headers, method: req.method, signal: req.signal },
        options,
      );

      if (trace === undefined || response.body === null) {
        return new Response(response.body, decodedBodyResponseInit(response));
      }
      const [returnedBody, tracedBody] = response.body.tee();
      void recordTrace(trace, response.status, tracedBody);
      return new Response(returnedBody, decodedBodyResponseInit(response));
    },
  };
}

// sdk 模式：baseURL 即 @ai-sdk/* 的入参；剥去 inbound 标准路径的版本前缀，
// 余下操作路径拼到 baseURL path 之后（与各包自身的拼接行为一致）。
function sdkRewrittenUrl(baseURL: string, requestUrl: string, protocol: ProviderProtocol): URL {
  const incomingUrl = new URL(requestUrl);
  const prefix = SDK_VERSION_PREFIXES[protocol];
  const operationPath =
    incomingUrl.pathname === prefix || incomingUrl.pathname.startsWith(`${prefix}/`)
      ? incomingUrl.pathname.slice(prefix.length)
      : incomingUrl.pathname;
  const upstreamUrl = new URL(baseURL);
  upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/$/u, '')}${operationPath}`;
  upstreamUrl.search = incomingUrl.search;
  return upstreamUrl;
}

function upstreamHeaders(
  inbound: Headers,
  config: Pick<ApiProviderConfig, 'apiKey' | 'headers'>,
  endpoint: Pick<NormalizedApiEndpoint, 'protocol' | 'auth'>,
): Headers {
  const headers = new Headers(inbound);
  headers.delete('host');
  headers.delete('accept-encoding');
  for (const name of CLIENT_CREDENTIAL_HEADERS) headers.delete(name);
  const apiKey = resolveApiKey(config.apiKey);
  if (apiKey !== undefined) {
    if (endpoint.protocol === ProviderProtocol.Anthropic && endpoint.auth !== 'bearer') {
      headers.set('x-api-key', apiKey);
    } else if (
      endpoint.protocol === ProviderProtocol.Gemini ||
      endpoint.protocol === ProviderProtocol.GeminiInteractions
    ) {
      headers.set('x-goog-api-key', apiKey);
    } else {
      headers.set('authorization', `Bearer ${apiKey}`);
    }
  }
  for (const [name, value] of Object.entries(config.headers ?? {})) headers.set(name, value);
  return headers;
}

function decodedBodyResponseInit(response: Response): ResponseInit {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return {
    headers,
    status: response.status,
    statusText: response.statusText,
  };
}

function rewrittenUrl(baseURL: string, requestUrl: string): URL {
  const upstreamUrl = new URL(baseURL);
  const incomingUrl = new URL(requestUrl);
  upstreamUrl.pathname = incomingUrl.pathname;
  upstreamUrl.search = incomingUrl.search;

  return upstreamUrl;
}

export function resolveApiKey(apiKey: string | undefined): string | undefined {
  if (apiKey === undefined) {
    return undefined;
  }

  if (!apiKey.startsWith('$')) {
    return apiKey;
  }

  return process.env[apiKey.slice(1)];
}

async function recordTrace(
  trace: ApiProviderTraceTarget,
  status: number,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  const bytes = await new Response(body).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const entry: ApiProviderTrace = {
    bodySha256: hex(digest),
    ...(status === 429 ? { category: 'rate_limit' } : {}),
    status,
  };

  if (Array.isArray(trace)) {
    trace.push(entry);
    return;
  }

  trace.record(entry);
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
