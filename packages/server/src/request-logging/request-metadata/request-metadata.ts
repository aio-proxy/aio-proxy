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

/**
 * query 里的凭据同样要脱。不少上游认证走 URL（Google 的 `?key=`、各家的 `?api_key=`），
 * 而 header 那份名单保护不到它 —— 抓包接口会把这里记下的 URL 原样送进浏览器。
 *
 * 参数名是无界的，所以按词匹配而不是整串包含：把名字切成词，任一段命中就脱。
 * `api_key` / `apikey` / `access_token` / `x-goog-api-key` / `client_secret` / `sig` 都中，
 * 而 `keyword`、`monkey` 这种不会被误伤。宁可多脱一个：一个被打码的调试字段只是不好查，
 * 一个漏掉的凭据是能直接拿去冒用的。
 *
 * 切词必须**同时**认非字母数字和 camelCase 边界。只切前者的话 `accessToken` 小写成
 * `accesstoken` 是一个整词，单词表里没有，于是明文落盘 —— `authToken`、`clientSecret`、
 * `refreshToken` 同理。（`apiKey` 侥幸命中，因为 `apikey` 恰好在表里。）
 */
const credentialQueryWords = new Set([
  'key',
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'auth',
  'sig',
  'signature',
  'credential',
  'credentials',
]);

function isCredentialParam(name: string): boolean {
  return (
    name
      // 小写化之前先在 camelCase 边界插空格，否则大小写信息就没了。两条规则：
      // `accessToken` → `access Token`，以及 `APIKey` → `API Key`（缩写接单词）。
      .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .some((word) => credentialQueryWords.has(word))
  );
}

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

/**
 * 同样给读侧用：凭据头这份名单是后来才扩的（原来只有 authorization 和 x-api-key），
 * 在那之前落盘的日志里 cookie / api-key / x-goog-api-key 都是明文。抓包接口读的是
 * 磁盘上已经存在的那些行，所以读出来也要按当前名单再脱一遍。
 */
export function redactCredentialHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      credentialHeaders.has(name.toLowerCase()) ? REDACTED : value,
    ]),
  );
}

/**
 * 也给读侧用：这个修复之前写下的日志文件里，query 凭据是明文。写侧只能挡住新的，
 * 抓包接口读的是磁盘上已经存在的那些行，所以两个边界都要过一遍。
 */
export function redactUrlCredentials(value: string): string {
  try {
    return visibleUrl(value);
  } catch {
    return value;
  }
}

function visibleUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  for (const name of [...url.searchParams.keys()]) {
    if (isCredentialParam(name)) url.searchParams.set(name, REDACTED);
  }
  return url.toString();
}

function visibleHeaders(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...headers].map(([name, value]) => [name, credentialHeaders.has(name.toLowerCase()) ? REDACTED : value]),
  );
}
