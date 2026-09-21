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
 *
 * 这份固定名单**不够**：provider 配置允许写任意 header（`api.ts` 会把 `config.headers` 逐条
 * set 到上游请求上），所以 `X-Secret`、`X-Auth-Token` 这类自定义认证头一个都不在名单里。
 * 因此名单之外再按词判一次，与 query 参数共用同一套凭据词表。
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
 *
 * 但 camelCase 切词救不了 header：Fetch 的 `Headers` 在构造时就把名字小写化了，所以
 * `X-ClientSecret` 到这里已经是 `x-clientsecret`，大小写信息没了，切出来是 `clientsecret`
 * 一个整词。于是整词之外再判后缀，覆盖这类切不开的复合名。
 *
 * 后缀表收 `key` 是刻意的，代价是 `monkey`、`turnkey` 这种普通词也被打码 —— 按本文件开头
 * 那条取舍（漏一个凭据的代价远高于多打一个调试字段），`X-SecretKey` / `X-PrivateKey` /
 * `X-ClientKey` 这些真实存在的认证头必须命中。`sig` 仍留在整词匹配里：它太短，收进后缀会
 * 连 `design`、`signal` 一起打掉，而这两个是真会出现的字段名。
 *
 * 后缀不等于子串：`keyword`、`tokenizer` 不以凭据词结尾，所以不受影响。
 */
const credentialQueryWords = new Set([
  'key',
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'auth',
  'authorization',
  'authentication',
  'bearer',
  'sig',
  'signature',
  'credential',
  'credentials',
]);

// 后缀匹配用的子集：只排掉 `sig`（太短，会连 `design` / `signal` 一起打掉）。
const CREDENTIAL_SUFFIXES = [...credentialQueryWords].filter((word) => word !== 'sig');

function isCredentialParam(name: string): boolean {
  return (
    name
      // 小写化之前先在 camelCase 边界插空格，否则大小写信息就没了。两条规则：
      // `accessToken` → `access Token`，以及 `APIKey` → `API Key`（缩写接单词）。
      .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .some((word) => credentialQueryWords.has(word) || CREDENTIAL_SUFFIXES.some((suffix) => word.endsWith(suffix)))
  );
}

/**
 * 固定名单命中，或名字里含凭据词。后者兜住 provider 配置里的自定义认证头 ——
 * `X-Secret` → `['x','secret']`、`X-Auth-Token` → `['x','auth','token']` 都中。
 * `X-Authorization` / `X-Authentication` / `X-Bearer` 小写化后切出
 * `authorization` / `authentication` / `bearer`，这三个词必须在表里：
 * 前两个不以 `auth` 结尾，`bearer` 更对不上任何现有词。
 * `content-type`、`x-request-id`、`user-agent` 这些不含凭据词，不受影响。
 */
function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return credentialHeaders.has(lower) || isCredentialParam(lower);
}

// 头名字本身不是凭据，值却是可复用的签名 URL。只按名字判的话 `Location` /
// `Operation-Location` / `Link` 会带着 `?access_token=` / `?X-Amz-Signature=` 明文落盘，
// 再经抓包接口送进浏览器。名单是「值按约定是 URL」的头，不是「看起来像 URL」的值。
const urlValuedHeaders = new Set([
  'location',
  'content-location',
  'operation-location',
  'azure-asyncoperation',
  'referer',
  'link',
]);

function visibleHeaderValue(name: string, value: string): string {
  if (isCredentialHeader(name)) return REDACTED;
  return urlValuedHeaders.has(name.toLowerCase()) ? redactUrlValue(value) : value;
}

function stripUrlCredentials(url: URL): URL {
  url.username = '';
  url.password = '';
  for (const param of [...url.searchParams.keys()]) {
    if (isCredentialParam(param)) url.searchParams.set(param, REDACTED);
  }
  url.hash = redactCredentialFragment(url.hash);
  return url;
}

// OAuth implicit / 前端回调常把 token 放在 `#access_token=`，query 那条扫不到。
// 没有 `=` 的 `#section` 原样留下，避免把锚点改写成空参数。
function redactCredentialFragment(hash: string): string {
  if (hash === '' || hash === '#') return hash;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.includes('=')) return hash;
  const params = new URLSearchParams(raw);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (!isCredentialParam(key)) continue;
    params.set(key, REDACTED);
    changed = true;
  }
  return changed ? `#${params.toString()}` : hash;
}

function redactUrlValue(value: string): string {
  // RFC 8288 Link：`<url>; rel="next"`。整段不是 URL，`new URL` 解析不了，
  // 只改尖括号里的目标，参数原样留下。
  if (value.includes('<')) {
    return value.replace(/<([^>]+)>/gu, (_, url: string) => `<${redactBareUrl(url)}>`);
  }
  return redactBareUrl(value);
}

function redactBareUrl(value: string): string {
  try {
    return stripUrlCredentials(new URL(value)).toString();
  } catch {
    // Location / Link 目标经常是相对引用：`/ops?token=`、`?token=`、`jobs/next?token=`。
    // 只认 `/` 和 `?` 前缀会把 path-relative 签名 URL 原样留下。
    try {
      const url = stripUrlCredentials(new URL(value, 'https://aio-proxy.invalid'));
      // `//cdn.example/jobs` 也以 `/` 开头，但 authority 在 host 上；按 path-only 会把
      // 签名目标收成 `/jobs`，丢掉跳转还在用的 host。
      if (value.startsWith('//')) return `//${url.host}${url.pathname}${url.search}${url.hash}`;
      if (value.startsWith('/') || value.startsWith('?')) return `${url.pathname}${url.search}${url.hash}`;
      // 空格这种明显不是 URL 的值不要改写成编码路径。
      if (/\s/u.test(value)) return value;
      return `${url.pathname.replace(/^\//u, '')}${url.search}${url.hash}`;
    } catch {
      return value;
    }
  }
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
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, visibleHeaderValue(name, value)]));
}

/**
 * 也给读侧用：这个修复之前写下的日志文件里，query 凭据是明文。写侧只能挡住新的，
 * 抓包接口读的是磁盘上已经存在的那些行，所以两个边界都要过一遍。
 */
export function redactUrlCredentials(value: string): string {
  return redactUrlValue(value);
}

function visibleUrl(value: string): string {
  return stripUrlCredentials(new URL(value)).toString();
}

function visibleHeaders(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries([...headers].map(([name, value]) => [name, visibleHeaderValue(name, value)]));
}
