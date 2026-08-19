import {
  AgentRuntimeError,
  CATALOG_REFRESH_INTERVAL_MS,
  createSingleFlight,
  pollDeviceAuthorization,
  readLastKnownCatalog,
  readManagedInstallation,
  refreshAgentCatalog,
  refreshAgentCredential,
  requestDeviceAuthorization,
  type RefreshCatalogResult,
} from '@aio-proxy/agent-provider-runtime';
import type { Config, Hooks, PluginInput, PluginModule } from '@opencode-ai/plugin';

import { openCodeCatalogDigest, toOpenCodeModels } from '../catalog';

const PROVIDER_ID = 'aio-proxy';
const loginRequired = (): Error => new Error('aio-proxy login required');
type AuthLoader = NonNullable<NonNullable<Hooks['auth']>['loader']>;
type GetAuth = Parameters<AuthLoader>[0];
type Auth = Awaited<ReturnType<GetAuth>>;
type OAuthAuth = Extract<Auth, { type: 'oauth' }>;

export type OpenCodeV1Deps = {
  readonly now: () => number;
  readonly fetch: typeof globalThis.fetch;
  readonly readManagedInstallation: typeof readManagedInstallation;
  readonly readLastKnownCatalog: typeof readLastKnownCatalog;
  readonly requestDeviceAuthorization: typeof requestDeviceAuthorization;
  readonly pollDeviceAuthorization: typeof pollDeviceAuthorization;
  readonly refreshAgentCredential: typeof refreshAgentCredential;
  readonly refreshAgentCatalog: typeof refreshAgentCatalog;
  readonly setInterval: (callback: () => void, milliseconds: number) => ReturnType<typeof globalThis.setInterval>;
  readonly clearInterval: (handle: ReturnType<typeof globalThis.setInterval>) => void;
};

const productionDeps: OpenCodeV1Deps = {
  now: Date.now,
  fetch: globalThis.fetch.bind(globalThis),
  readManagedInstallation,
  readLastKnownCatalog,
  requestDeviceAuthorization,
  pollDeviceAuthorization,
  refreshAgentCredential,
  refreshAgentCatalog,
  setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
  clearInterval: (handle) => globalThis.clearInterval(handle),
};

export async function createOpenCodeV1Server(input: PluginInput, deps: OpenCodeV1Deps): Promise<Hooks> {
  const managed = await deps.readManagedInstallation(import.meta.url, 'opencode');
  let catalog = await deps.readLastKnownCatalog(managed.statePath, 'opencode');
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const rotate = createSingleFlight(async (getAuth: GetAuth): Promise<OAuthAuth> => {
    const current = await getAuth();
    if (current.type !== 'oauth') throw new Error('aio-proxy login required');
    let token: Awaited<ReturnType<typeof refreshAgentCredential>>;
    try {
      token = await deps.refreshAgentCredential(managed.marker, current.refresh, {
        fetch: deps.fetch,
        now: deps.now,
      });
    } catch (error) {
      if (error instanceof AgentRuntimeError && error.code === 'invalid_grant') throw loginRequired();
      throw error;
    }
    const next: OAuthAuth = {
      type: 'oauth',
      access: token.access_token,
      refresh: token.refresh_token,
      expires: deps.now() + token.expires_in * 1_000,
    };
    await input.client.auth.set({ path: { id: PROVIDER_ID }, body: next });
    return next;
  });

  async function resolveAccess(getAuth: GetAuth): Promise<string> {
    const current = await getAuth();
    if (current.type !== 'oauth') throw new Error('aio-proxy login required');
    if (current.access !== '' && current.expires > deps.now()) return current.access;
    return (await rotate(getAuth)).access;
  }

  async function recoverUnauthorized(getAuth: GetAuth, rejectedAccess: string): Promise<OAuthAuth> {
    const current = await getAuth();
    if (current.type !== 'oauth') throw new Error('aio-proxy login required');
    if (current.access !== rejectedAccess && current.expires > deps.now()) return current;
    return rotate(getAuth);
  }

  async function fetchWithAccess(access: string, request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${access}`);
    return deps.fetch(new Request(request, { headers }));
  }

  async function authenticatedFetch(
    getAuth: GetAuth,
    request: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const normalized = new Request(request, init);
    const access = await resolveAccess(getAuth);
    // Preserve one untouched copy for the authenticated retry. This matters for
    // Request bodies backed by streams, which cannot be reconstructed after fetch.
    const first = await fetchWithAccess(access, normalized.clone());
    if (first.status !== 401) return first;
    const next = await recoverUnauthorized(getAuth, access);
    return fetchWithAccess(next.access, normalized);
  }

  async function refreshWithAccess(accessToken: string, rebuildOnChange = true): Promise<RefreshCatalogResult> {
    const before = openCodeCatalogDigest(catalog);
    const result = await deps.refreshAgentCatalog({
      marker: managed.marker,
      statePath: managed.statePath,
      accessToken,
      fetch: deps.fetch,
      now: deps.now,
    });
    catalog = result.catalog;
    if (rebuildOnChange && openCodeCatalogDigest(catalog) !== before) {
      await input.client.instance.dispose();
    }
    return result;
  }

  async function refreshFromStoredCredential(getAuth: GetAuth): Promise<void> {
    const access = await resolveAccess(getAuth);
    const first = await refreshWithAccess(access);
    if (first.error !== 'unauthorized') return;
    const next = await recoverUnauthorized(getAuth, access);
    const second = await refreshWithAccess(next.access);
    if (second.error === 'unauthorized') throw loginRequired();
  }

  const refreshCatalogFromStore = createSingleFlight(refreshFromStoredCredential);

  async function createLoader(getAuth: GetAuth): Promise<Record<string, unknown>> {
    await refreshCatalogFromStore(getAuth);
    timer ??= deps.setInterval(() => {
      void refreshCatalogFromStore(getAuth).catch(() => {
        console.warn('[aio-proxy] background catalog refresh failed');
      });
    }, CATALOG_REFRESH_INTERVAL_MS);
    return {
      apiKey: 'aio-proxy-managed',
      fetch: authenticatedFetch.bind(undefined, getAuth),
    };
  }

  async function publishConfig(config: Config): Promise<void> {
    config.provider ??= {};
    config.provider[PROVIDER_ID] = {
      name: PROVIDER_ID,
      npm: '@ai-sdk/openai-compatible',
      options: {
        apiKey: 'aio-proxy-managed',
        baseURL: new URL('/v1', managed.marker.endpoint).href.replace(/\/$/u, ''),
      },
      models: catalog === null ? {} : toOpenCodeModels(catalog),
    };
  }

  return {
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: 'oauth',
          label: PROVIDER_ID,
          async authorize() {
            const device = await deps.requestDeviceAuthorization(managed.marker, {
              fetch: deps.fetch,
              now: deps.now,
            });
            return {
              method: 'auto' as const,
              url: device.verification_uri_complete,
              instructions: `Approve aio-proxy with code ${device.user_code}`,
              callback: async () => {
                const token = await deps.pollDeviceAuthorization(managed.marker, device, {
                  fetch: deps.fetch,
                  now: deps.now,
                });
                const result = await refreshWithAccess(token.access_token, false);
                if (result.error === 'unauthorized') throw loginRequired();
                return {
                  type: 'success' as const,
                  provider: PROVIDER_ID,
                  access: token.access_token,
                  refresh: token.refresh_token,
                  expires: deps.now() + token.expires_in * 1_000,
                };
              },
            };
          },
        },
      ],
      loader: createLoader,
    },
    config: publishConfig,
    async dispose() {
      if (timer !== undefined) deps.clearInterval(timer);
      timer = undefined;
    },
  };
}

export const opencodePlugin = {
  id: PROVIDER_ID,
  server: (input) => createOpenCodeV1Server(input, productionDeps),
} satisfies PluginModule;
