import { PACKAGE, RELEASE_METADATA_TIMEOUT_MS } from './constants';

export const fetchLatestVersion = async (registry: string, fetchImpl: typeof fetch = fetch): Promise<string> => {
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  const res = await fetchImpl(`${base}${PACKAGE}/latest`, { signal: AbortSignal.timeout(RELEASE_METADATA_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`failed to fetch latest version: ${res.status}`);
  const data = (await res.json()) as { version?: string };
  if (typeof data.version !== 'string') throw new Error('registry response missing version');
  return data.version;
};
