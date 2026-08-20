import {
  AgentRuntimeError,
  pollDeviceAuthorization,
  readLastKnownCatalog,
  refreshAgentCatalog,
  refreshAgentCredential,
  requestDeviceAuthorization,
  type ManagedInstallation,
  type RefreshCatalogResult,
} from '@aio-proxy/agent-provider-runtime';
import type { AgentCatalogV1, AgentDeviceCodeResponse, AgentManagedMarker, AgentTarget } from '@aio-proxy/types';

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_OUTPUT = 16_384;

export type OAuthCredentials = { readonly access: string; readonly refresh: string; readonly expires: number };
export type PiFamilyModel = {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: Array<'text' | 'image'>;
  readonly cost: { readonly input: 0; readonly output: 0; readonly cacheRead: 0; readonly cacheWrite: 0 };
  readonly contextWindow: number;
  readonly maxTokens: number;
};
export type PiFamilyCatalogResult = {
  readonly models: PiFamilyModel[];
  readonly source: RefreshCatalogResult['source'];
  readonly status: RefreshCatalogResult['status'];
  readonly error?: RefreshCatalogResult['error'];
};

export function piFamilyUnavailableMessage(error: RefreshCatalogResult['error']): string {
  if (error === 'unauthorized') return 'aio-proxy login required';
  if (error === 'unsupported_schema') return 'aio-proxy adapter upgrade required';
  return 'aio-proxy server required';
}

export const toPiFamilyModels = (catalog: AgentCatalogV1): PiFamilyModel[] =>
  catalog.models.map((model) => {
    const contextWindow = model.context_window ?? DEFAULT_CONTEXT;
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image'),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: Math.min(contextWindow, model.max_output_tokens ?? DEFAULT_OUTPUT),
    };
  });

type CoreOptions = {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly requestDeviceAuthorization?: typeof requestDeviceAuthorization;
  readonly pollDeviceAuthorization?: typeof pollDeviceAuthorization;
  readonly refreshAgentCredential?: typeof refreshAgentCredential;
  readonly refreshAgentCatalog?: typeof refreshAgentCatalog;
  readonly readLastKnownCatalog?: (statePath: string, expectedTarget: AgentTarget) => Promise<AgentCatalogV1 | null>;
};

const credentialFromToken = (
  token: { readonly access_token: string; readonly refresh_token: string; readonly expires_in: number },
  now: () => number,
): OAuthCredentials => ({
  access: token.access_token,
  refresh: token.refresh_token,
  expires: now() + token.expires_in * 1_000,
});

export async function loginPiFamily(
  managed: ManagedInstallation,
  presentDevice: (device: AgentDeviceCodeResponse) => void,
  options: CoreOptions = {},
): Promise<OAuthCredentials> {
  const request = options.requestDeviceAuthorization ?? requestDeviceAuthorization;
  const poll = options.pollDeviceAuthorization ?? pollDeviceAuthorization;
  const device = await request(managed.marker, options);
  presentDevice(device);
  const token = await poll(managed.marker, device, options);
  const catalog = await (options.refreshAgentCatalog ?? refreshAgentCatalog)({
    marker: managed.marker,
    statePath: managed.statePath,
    accessToken: token.access_token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (catalog.error === 'unauthorized' || catalog.source === 'missing') {
    throw new Error(piFamilyUnavailableMessage(catalog.error));
  }
  return credentialFromToken(token, options.now ?? Date.now);
}

const refreshFlights = new Map<string, Promise<OAuthCredentials>>();

const refreshPiFamilyCredentialOnce = async (
  marker: AgentManagedMarker,
  credential: OAuthCredentials,
  options: CoreOptions,
): Promise<OAuthCredentials> => {
  let token: Awaited<ReturnType<typeof refreshAgentCredential>>;
  try {
    token = await (options.refreshAgentCredential ?? refreshAgentCredential)(marker, credential.refresh, options);
  } catch (error) {
    if (error instanceof AgentRuntimeError && error.code === 'invalid_grant')
      throw new Error('aio-proxy login required');
    throw error;
  }
  return credentialFromToken(token, options.now ?? Date.now);
};

export async function refreshPiFamilyCredential(
  marker: AgentManagedMarker,
  credential: OAuthCredentials,
  options: CoreOptions = {},
): Promise<OAuthCredentials> {
  const key = `${marker.installationId}\0${credential.refresh}`;
  const active = refreshFlights.get(key);
  if (active !== undefined) return active;
  const flight = Promise.resolve()
    .then(() => refreshPiFamilyCredentialOnce(marker, credential, options))
    .finally(() => {
      refreshFlights.delete(key);
    });
  refreshFlights.set(key, flight);
  return flight;
}

export async function readPiFamilyModels(
  managed: ManagedInstallation,
  accessToken: string | undefined,
  options: CoreOptions = {},
): Promise<PiFamilyCatalogResult> {
  if (accessToken === undefined) {
    const lkg = await (options.readLastKnownCatalog ?? readLastKnownCatalog)(managed.statePath, managed.marker.agent);
    return lkg === null
      ? { models: [], source: 'missing', status: 'missing' }
      : { models: toPiFamilyModels(lkg), source: 'lkg', status: 'stale' };
  }
  const result = await (options.refreshAgentCatalog ?? refreshAgentCatalog)({
    marker: managed.marker,
    statePath: managed.statePath,
    accessToken,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    models: result.catalog === null ? [] : toPiFamilyModels(result.catalog),
    source: result.source,
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}
