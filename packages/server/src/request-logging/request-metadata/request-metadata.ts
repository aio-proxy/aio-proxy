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
const credentialHeaders = new Set(['authorization', 'x-api-key']);

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
