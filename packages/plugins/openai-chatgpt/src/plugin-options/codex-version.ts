import type { RuntimeFetch } from '@aio-proxy/plugin-sdk';

import { CODEX_CLIENT_VERSION } from '../codex-client';

const RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
const RELEASE_TAG = /^rust-v(\d+\.\d+\.\d+)$/u;
export const CODEX_VERSION_FRESH_MS = 60 * 60 * 1000;
export const CODEX_VERSION_RETRY_MS = 5 * 60 * 1000;

type VersionCache = {
  version: string;
  freshUntil: number;
};

let cache: VersionCache | undefined;
let inflight: Promise<string> | undefined;

// Bound at load so a later test replacement of `globalThis.fetch` does not
// redirect this lookup onto a model-request mock.
const ambientFetch: RuntimeFetch = globalThis.fetch.bind(globalThis);

export function resetLatestCodexRsVersionCache(): void {
  cache = undefined;
  inflight = undefined;
}

export async function latestCodexRsVersion(fetchImpl: RuntimeFetch = ambientFetch, now = Date.now()): Promise<string> {
  if (cache !== undefined && cache.freshUntil > now) return cache.version;
  inflight ??= loadVersion(fetchImpl, now).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function loadVersion(fetchImpl: RuntimeFetch, now: number): Promise<string> {
  try {
    const version = await fetchLatestRelease(fetchImpl);
    cache = { version, freshUntil: now + CODEX_VERSION_FRESH_MS };
    return version;
  } catch {
    const version = cache?.version ?? CODEX_CLIENT_VERSION;
    cache = { version, freshUntil: now + CODEX_VERSION_RETRY_MS };
    return version;
  }
}

async function fetchLatestRelease(fetchImpl: RuntimeFetch): Promise<string> {
  const response = await fetchImpl(RELEASES_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'aio-proxy',
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Codex release lookup failed with ${response.status}`);
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || Reflect.get(body, 'prerelease') === true) {
    throw new Error('Codex release lookup returned an unexpected body');
  }
  const tag = Reflect.get(body, 'tag_name');
  const version = typeof tag === 'string' ? RELEASE_TAG.exec(tag)?.[1] : undefined;
  if (version === undefined) throw new Error('Codex release lookup returned an unexpected tag');
  return version;
}
