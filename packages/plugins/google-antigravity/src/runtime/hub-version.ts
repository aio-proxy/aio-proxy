const HUB_VERSION_MANIFEST =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const FALLBACK_VERSION = "2.2.1";
const CACHE_TTL_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export const ANTIGRAVITY_GOOGLE_API_CLIENT = "gl-node/22.21.1";

export type HubVersionCache = {
  readonly version: () => string;
  readonly shortUserAgent: () => string;
  readonly onboardingUserAgent: () => string;
};

export function createHubVersionCache(
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => number;
    readonly timeoutSignal?: () => AbortSignal;
    readonly platform?: string;
    readonly arch?: string;
  } = {},
): HubVersionCache {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const runtime = globalThis as typeof globalThis & {
    readonly process?: { readonly platform?: string; readonly arch?: string };
  };
  const platform = options.platform ?? runtime.process?.platform ?? "unknown";
  const arch = options.arch ?? runtime.process?.arch ?? "unknown";
  let cachedVersion = FALLBACK_VERSION;
  let expiresAt = 0;
  let refreshFlight: Promise<void> | undefined;

  const refresh = async (): Promise<void> => {
    try {
      const response = await fetchImpl(HUB_VERSION_MANIFEST, {
        headers: { "Cache-Control": "no-cache", "User-Agent": "electron-builder" },
        signal: (options.timeoutSignal ?? (() => AbortSignal.timeout(FETCH_TIMEOUT_MS)))(),
      });
      if (!response.ok) throw new Error("manifest request failed");
      const version = parseVersion(await response.text());
      if (version === undefined) throw new Error("manifest version is invalid");
      cachedVersion = version;
    } catch {
      // The last verified version, including the built-in fallback, remains usable.
    } finally {
      expiresAt = now() + CACHE_TTL_MS;
    }
  };

  const version = (): string => {
    if (now() >= expiresAt && refreshFlight === undefined) {
      refreshFlight = refresh().finally(() => {
        refreshFlight = undefined;
      });
      void refreshFlight;
    }
    return cachedVersion;
  };

  const shortUserAgent = (): string => `antigravity/hub/${version()} ${platform}/${arch}`;
  return {
    version,
    shortUserAgent,
    onboardingUserAgent: () => `${shortUserAgent()} google-api-nodejs-client/10.3.0`,
  };
}

function parseVersion(manifest: string): string | undefined {
  for (const line of manifest.split(/\r?\n/u)) {
    const match = /^version:\s*([0-9]+(?:\.[0-9]+)*)\s*$/u.exec(line.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

const sharedCache = createHubVersionCache();

export function hubVersion(): string {
  return sharedCache.version();
}

export function antigravityUserAgent(): string {
  return sharedCache.shortUserAgent();
}

export function antigravityOnboardingUserAgent(): string {
  return sharedCache.onboardingUserAgent();
}
