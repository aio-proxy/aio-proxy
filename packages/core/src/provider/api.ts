import type { ApiProvider, ModelEntry, ProviderKind, ProviderProtocol } from "@aio-proxy/types";

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

export type ApiProviderConfig = Omit<ApiProvider, "baseUrl" | "id"> & {
  readonly baseUrl: string;
  readonly id: string;
  readonly trace?: ApiProviderTraceTarget;
};

export type ApiProviderInstance = {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly id: string;
  readonly kind: ProviderKind.Api;
  readonly models?: readonly ModelEntry[];
  readonly passthrough: (req: Request) => Promise<Response>;
  readonly protocol: ProviderProtocol;
};

export type ApiProviderFactoryOptions = {
  readonly trace?: ApiProviderTraceTarget;
};

export function createApiProvider(
  config: ApiProviderConfig,
  options: ApiProviderFactoryOptions = {},
): ApiProviderInstance {
  const baseUrl = config.baseUrl;
  const trace = options.trace ?? config.trace;

  return {
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    baseUrl,
    id: config.id,
    kind: config.kind,
    ...(config.models === undefined ? {} : { models: config.models }),
    protocol: config.protocol,
    async passthrough(req) {
      const upstreamUrl = rewrittenUrl(baseUrl, req.url);
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.set("accept-encoding", "identity");
      headers.set("x-forwarded-by", "aio-proxy/0.0.0");

      const apiKey = resolveApiKey(config.apiKey);
      if (apiKey !== undefined) {
        headers.set("authorization", `Bearer ${apiKey}`);
      }

      const response = await fetch(upstreamUrl, {
        body: req.body,
        headers,
        method: req.method,
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

function rewrittenUrl(baseUrl: string, requestUrl: string): URL {
  const upstreamUrl = new URL(baseUrl);
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
