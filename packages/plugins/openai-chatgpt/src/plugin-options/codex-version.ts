import type { RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { CODEX_CLIENT_VERSION } from '../codex-client';

const RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
const NPM_URL = 'https://registry.npmjs.org/@openai/codex/latest';
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const CODEX_VERSION_FRESH_MS = 60 * 60 * 1000;
export const CODEX_VERSION_RETRY_MS = 5 * 60 * 1000;

type VersionCache = {
  version: string;
  freshUntil: number;
};

let cache: VersionCache | undefined;
let inflight: Promise<string> | undefined;

export function resetLatestCodexRsVersionCache(): void {
  cache = undefined;
  inflight = undefined;
}

export async function latestCodexRsVersion(fetchImpl: RuntimeFetch, now = Date.now()): Promise<string> {
  if (cache !== undefined && cache.freshUntil > now) return cache.version;
  inflight ??= loadVersion(fetchImpl, now).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function loadVersion(fetchImpl: RuntimeFetch, now: number): Promise<string> {
  let newest = cache?.version;
  const accept = (version: string): string => {
    // Release publication is not atomic across npm and GitHub. Return the first
    // success, then let a slower, newer release upgrade this same cache entry.
    if (newest === undefined || Bun.semver.order(version, newest) > 0) newest = version;
    cache = { version: newest, freshUntil: now + CODEX_VERSION_FRESH_MS };
    return newest;
  };
  try {
    return await Promise.any([
      fetchVersion(RELEASES_URL, fetchImpl).then(accept),
      fetchVersion(NPM_URL, fetchImpl).then(accept),
    ]);
  } catch {
    const version = cache?.version ?? CODEX_CLIENT_VERSION;
    cache = { version, freshUntil: now + CODEX_VERSION_RETRY_MS };
    return version;
  }
}

async function fetchVersion(url: string, fetchImpl: RuntimeFetch): Promise<string> {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'aio-proxy',
    },
    signal: AbortSignal.timeout(5_000),
    aioProxy: { traffic: 'control' },
  });
  if (!response.ok) throw new Error(`Codex release lookup failed with ${response.status}`);
  const body: unknown = await response.json();
  if (!isPlainObject(body) || body['prerelease'] === true || body['draft'] === true) {
    throw new Error('Codex release lookup returned an unexpected body');
  }
  const tag = body['tag_name'];
  const version =
    url === RELEASES_URL
      ? typeof tag === 'string' && tag.startsWith('rust-v')
        ? tag.slice(6)
        : undefined
      : body['name'] === '@openai/codex'
        ? body['version']
        : undefined;
  if (typeof version !== 'string' || !STABLE_VERSION.test(version))
    throw new Error('Codex release lookup returned an unexpected version');
  return version;
}
