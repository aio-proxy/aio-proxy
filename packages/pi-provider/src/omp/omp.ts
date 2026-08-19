import { CATALOG_REFRESH_INTERVAL_MS, readManagedInstallation } from '@aio-proxy/agent-provider-runtime';
import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from '@oh-my-pi/pi-coding-agent';

import { loginPiFamily, piFamilyUnavailableMessage, readPiFamilyModels, refreshPiFamilyCredential } from '../core';

const PROVIDER_ID = 'aio-proxy';

export type OmpDeps = {
  readonly readManagedInstallation: typeof readManagedInstallation;
  readonly loginPiFamily: typeof loginPiFamily;
  readonly refreshPiFamilyCredential: typeof refreshPiFamilyCredential;
  readonly readPiFamilyModels: typeof readPiFamilyModels;
};

const productionDeps: OmpDeps = {
  readManagedInstallation,
  loginPiFamily,
  refreshPiFamilyCredential,
  readPiFamilyModels,
};

export async function registerOmp(pi: ExtensionAPI, deps: OmpDeps): Promise<void> {
  const managed = await deps.readManagedInstallation(import.meta.url, 'omp');
  let context: ExtensionContext | undefined;
  let generation = 0;
  let timerStarted = false;
  type PendingRecovery = false | 'missing-key' | 'unauthorized';
  let pendingRecovery: PendingRecovery = false;
  let credentialRecoveryInProgress = false;
  type CatalogFlight = {
    readonly generation: number;
    readonly promise: Promise<ProviderModelConfig[]>;
  };
  const inflight = new Map<string | undefined, CatalogFlight>();

  const loginRequired = (): Error => new Error('aio-proxy login required');
  const resolveHostCredential = async (activeContext: ExtensionContext, forceRefresh: boolean): Promise<string> => {
    try {
      const key = await activeContext.modelRegistry.getApiKeyForProvider(
        PROVIDER_ID,
        undefined,
        forceRefresh ? { forceRefresh: true } : undefined,
      );
      if (key === undefined) throw loginRequired();
      return key;
    } catch {
      throw loginRequired();
    }
  };
  const forceRefreshCredential = (activeContext: ExtensionContext): Promise<string> =>
    resolveHostCredential(activeContext, true);

  const publishOrThrow = (result: Awaited<ReturnType<typeof readPiFamilyModels>>): ProviderModelConfig[] => {
    if (result.source === 'missing') throw new Error(piFamilyUnavailableMessage(result.error));
    return result.models;
  };

  const loadModels = async (apiKey: string | undefined): Promise<ProviderModelConfig[]> => {
    const startGeneration = generation;
    const startContext = context;
    const stillCurrent = () => generation === startGeneration && context === startContext;

    if (apiKey === undefined && startContext === undefined) {
      const lkg = await deps.readPiFamilyModels(managed, undefined);
      if (lkg.source === 'missing') throw loginRequired();
      if (stillCurrent()) pendingRecovery = 'missing-key';
      return lkg.models;
    }

    let key = apiKey;
    if (key === undefined) {
      key = await resolveHostCredential(startContext!, false);
    }
    const first = await deps.readPiFamilyModels(managed, key);
    if (first.error !== 'unauthorized') return publishOrThrow(first);
    if (startContext === undefined) {
      if (first.source === 'missing') throw loginRequired();
      if (stillCurrent()) pendingRecovery = 'unauthorized';
      return first.models;
    }
    if (!stillCurrent()) {
      if (first.source === 'missing') throw loginRequired();
      return first.models;
    }
    if (credentialRecoveryInProgress) throw loginRequired();
    const refreshed = await forceRefreshCredential(startContext);
    const second = await deps.readPiFamilyModels(managed, refreshed);
    if (second.error === 'unauthorized') throw loginRequired();
    return publishOrThrow(second);
  };

  const fetchModels = (apiKey: string | undefined): Promise<ProviderModelConfig[]> => {
    const startGeneration = generation;
    const existing = inflight.get(apiKey);
    if (existing !== undefined && existing.generation === startGeneration) return existing.promise;
    const promise = loadModels(apiKey).finally(() => {
      if (inflight.get(apiKey)?.promise === promise) inflight.delete(apiKey);
    });
    inflight.set(apiKey, { generation: startGeneration, promise });
    return promise;
  };

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: new URL('/v1', managed.marker.endpoint).href.replace(/\/$/u, ''),
    api: 'openai-completions',
    authHeader: true,
    oauth: {
      name: PROVIDER_ID,
      login: (callbacks) =>
        deps.loginPiFamily(
          managed,
          (device) =>
            callbacks.onAuth({
              url: device.verification_uri_complete,
              instructions: `Approve aio-proxy with code ${device.user_code}`,
            }),
          callbacks.signal === undefined ? {} : { signal: callbacks.signal },
        ),
      refreshToken: (credential) => deps.refreshPiFamilyCredential(managed.marker, credential),
      getApiKey: (credential) => credential.access,
    },
    fetchDynamicModels: fetchModels,
  });

  pi.on('session_start', async (_event, nextContext: ExtensionContext) => {
    const startGeneration = ++generation;
    context = nextContext;
    const recover = pendingRecovery;
    pendingRecovery = false;
    credentialRecoveryInProgress = recover !== false;
    try {
      if (recover !== false) {
        // Missing-key LKG recovery must reuse a peer-rotated host credential.
        // Only a pre-session 401 may force-refresh an unexpired token.
        await resolveHostCredential(nextContext, recover === 'unauthorized');
        if (generation !== startGeneration || context !== nextContext) return;
        await nextContext.modelRegistry.refreshRuntimeProviders('online');
      } else {
        await nextContext.modelRegistry.refreshRuntimeProviders('online');
      }
    } finally {
      if (generation === startGeneration) credentialRecoveryInProgress = false;
    }
    if (generation !== startGeneration || context !== nextContext || timerStarted) return;
    timerStarted = true;
    nextContext.setInterval(() => {
      void context?.modelRegistry
        .refreshRuntimeProviders('online')
        .catch(() => console.warn('[aio-proxy] OMP catalog refresh failed'));
    }, CATALOG_REFRESH_INTERVAL_MS);
  });
  pi.on('session_shutdown', () => {
    generation += 1;
    context = undefined;
    timerStarted = false;
    credentialRecoveryInProgress = false;
  });
}

export default async function omp(pi: ExtensionAPI): Promise<void> {
  await registerOmp(pi, productionDeps);
}
