import {
  CATALOG_REFRESH_INTERVAL_MS,
  createSingleFlight,
  readLastKnownCatalog,
  readManagedInstallation,
} from '@aio-proxy/agent-provider-runtime';
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
  ProviderModelConfig,
} from '@earendil-works/pi-coding-agent';

import {
  loginPiFamily,
  piFamilyUnavailableMessage,
  readPiFamilyModels,
  refreshPiFamilyCredential,
  toPiFamilyModels,
} from '../core';

const PROVIDER_ID = 'aio-proxy';
type RefreshModelsContext = Parameters<NonNullable<ProviderConfig['refreshModels']>>[0];

export type OfficialPiDeps = {
  readonly readManagedInstallation: typeof readManagedInstallation;
  readonly readLastKnownCatalog: typeof readLastKnownCatalog;
  readonly loginPiFamily: typeof loginPiFamily;
  readonly refreshPiFamilyCredential: typeof refreshPiFamilyCredential;
  readonly readPiFamilyModels: typeof readPiFamilyModels;
  readonly setInterval: typeof globalThis.setInterval;
  readonly clearInterval: typeof globalThis.clearInterval;
};

const productionDeps: OfficialPiDeps = {
  readManagedInstallation,
  readLastKnownCatalog,
  loginPiFamily,
  refreshPiFamilyCredential,
  readPiFamilyModels,
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

export async function registerOfficialPi(pi: ExtensionAPI, deps: OfficialPiDeps): Promise<void> {
  const managed = await deps.readManagedInstallation(import.meta.url, 'pi');
  const lkg = await deps.readLastKnownCatalog(managed.statePath, 'pi');
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const refreshModels = createSingleFlight(async (context: RefreshModelsContext): Promise<ProviderModelConfig[]> => {
    const access = context.credential?.type === 'oauth' ? context.credential.access : undefined;
    const result = context.allowNetwork
      ? await deps.readPiFamilyModels(managed, access, { signal: context.signal })
      : await deps
          .readLastKnownCatalog(managed.statePath, 'pi')
          .then((current) =>
            current === null
              ? { models: [], source: 'missing' as const, status: 'missing' as const }
              : { models: toPiFamilyModels(current), source: 'lkg' as const, status: 'stale' as const },
          );
    if (result.error === 'unauthorized') throw new Error('aio-proxy login required');
    if (result.source === 'missing') throw new Error(piFamilyUnavailableMessage(result.error));
    return [...result.models];
  });

  const config: ProviderConfig = {
    name: PROVIDER_ID,
    baseUrl: new URL('/v1', managed.marker.endpoint).href.replace(/\/$/u, ''),
    api: 'openai-completions',
    authHeader: true,
    models: lkg === null ? [] : [...toPiFamilyModels(lkg)],
    refreshModels,
    oauth: {
      name: PROVIDER_ID,
      login: (callbacks) =>
        deps.loginPiFamily(
          managed,
          (device) =>
            callbacks.onDeviceCode({
              userCode: device.user_code,
              verificationUri: device.verification_uri,
              intervalSeconds: device.interval,
              expiresInSeconds: device.expires_in,
            }),
          callbacks.signal === undefined ? {} : { signal: callbacks.signal },
        ),
      refreshToken: (credential, signal) =>
        deps.refreshPiFamilyCredential(managed.marker, credential, signal === undefined ? {} : { signal }),
      getApiKey: (credential) => credential.access,
    },
  };
  pi.registerProvider(PROVIDER_ID, config);

  pi.on('session_start', async (_event, context: ExtensionContext) => {
    await context.modelRegistry.refresh({ allowNetwork: true, providers: [PROVIDER_ID], force: true });
    timer ??= deps.setInterval(() => {
      void context.modelRegistry
        .refresh({ allowNetwork: true, providers: [PROVIDER_ID], force: true })
        .catch(() => console.warn('[aio-proxy] official Pi catalog refresh failed'));
    }, CATALOG_REFRESH_INTERVAL_MS);
  });
  pi.on('session_shutdown', () => {
    if (timer !== undefined) deps.clearInterval(timer);
    timer = undefined;
  });
}

export default async function officialPi(pi: ExtensionAPI): Promise<void> {
  await registerOfficialPi(pi, productionDeps);
}
