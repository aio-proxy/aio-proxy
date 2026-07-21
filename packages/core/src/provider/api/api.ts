import { type ApiProvider, ProviderProtocol } from "@aio-proxy/types";

import type { ProviderFetch } from "../proxy-fetch";

declare const process: {
  readonly env: Record<string, string | undefined>;
};

export type ApiProviderTrace = {
  readonly bodySha256: string;
  readonly category?: "rate_limit";
  readonly status: number;
};

export type ApiProviderTraceSink = {
  readonly record: (entry: ApiProviderTrace) => void;
};

type ApiProviderTraceTarget = ApiProviderTraceSink | ApiProviderTrace[];

const CLIENT_CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-goog-api-key",
] as const;

export type ApiProviderConfig = ApiProvider & {
  readonly trace?: ApiProviderTraceTarget;
};

export type ApiProviderInstance = ApiProvider & {
  readonly passthrough: (req: Request) => Promise<Response>;
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
  const baseURL = config.baseURL;
  const trace = options.trace ?? config.trace;
  const fetchUpstream = options.fetch ?? globalThis.fetch;

  return {
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    baseURL,
    enabled: config.enabled,
    id: config.id,
    kind: config.kind,
    ...(config.models === undefined ? {} : { models: config.models }),
    ...(config.alias === undefined ? {} : { alias: config.alias }),
    protocol: config.protocol,
    async passthrough(req) {
      const upstreamUrl = rewrittenUrl(baseURL, req.url);
      const headers = upstreamHeaders(req.headers, config.protocol, resolveApiKey(config.apiKey), config.headers);

      const response = await fetchUpstream(upstreamUrl, {
        body: req.body,
        headers,
        method: req.method,
        signal: req.signal,
      });

      if (trace === undefined || response.body === null) {
        return new Response(response.body, decodedBodyResponseInit(response));
      }

      const [returnedBody, tracedBody] = response.body.tee();
      void recordTrace(trace, response.status, tracedBody);

      return new Response(returnedBody, decodedBodyResponseInit(response));
    },
  };
}

function upstreamHeaders(
  inbound: Headers,
  protocol: ProviderProtocol,
  apiKey: string | undefined,
  configured: Readonly<Record<string, string>> | undefined,
): Headers {
  const headers = new Headers(inbound);
  headers.delete("host");
  for (const name of CLIENT_CREDENTIAL_HEADERS) headers.delete(name);
  headers.set("accept-encoding", "identity");
  headers.set("x-forwarded-by", "aio-proxy/0.0.0");
  if (apiKey !== undefined) {
    if (protocol === ProviderProtocol.Anthropic) headers.set("x-api-key", apiKey);
    else if (protocol === ProviderProtocol.Gemini) headers.set("x-goog-api-key", apiKey);
    else headers.set("authorization", `Bearer ${apiKey}`);
  }
  for (const [name, value] of Object.entries(configured ?? {})) headers.set(name, value);
  return headers;
}

function decodedBodyResponseInit(response: Response): ResponseInit {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
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

  if (!apiKey.startsWith("$")) {
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
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const entry: ApiProviderTrace = {
    bodySha256: hex(digest),
    ...(status === 429 ? { category: "rate_limit" } : {}),
    status,
  };

  if (Array.isArray(trace)) {
    trace.push(entry);
    return;
  }

  trace.record(entry);
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
