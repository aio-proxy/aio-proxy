export type HttpRequestMetadata = {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

export type HttpResponseMetadata = {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
};

const REDACTED = '[REDACTED]';
/**
 * 凭据头一律不落盘。除了 Bearer，各家上游还各有自己的 key 头（Anthropic `x-api-key`、
 * Google `x-goog-api-key`、Azure `api-key`），cookie 则是会话凭据 —— 拿到就能冒充。
 * 抓包接口会把这里记下的 headers 原样送进浏览器，所以宁可多脱一个也别漏一个。
 */
const credentialHeaders = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
]);

export function requestMetadata(request: Request): HttpRequestMetadata {
  try {
    return {
      method: request.method,
      url: visibleUrl(request.url),
      headers: visibleHeaders(request.headers),
    };
  } catch {
    return { method: '[UNREADABLE]', url: '[UNREADABLE]', headers: {} };
  }
}

export function responseMetadata(response: Response): HttpResponseMetadata {
  try {
    return { statusCode: response.status, headers: visibleHeaders(response.headers) };
  } catch {
    return { statusCode: 0, headers: {} };
  }
}

function visibleUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  return url.toString();
}

function visibleHeaders(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...headers].map(([name, value]) => [name, credentialHeaders.has(name.toLowerCase()) ? REDACTED : value]),
  );
}
