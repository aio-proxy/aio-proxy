import {
  type BuiltInPluginDefinition,
  type LocalBinding,
  type LocalEntity,
  type PluginRepository,
  type SyncRepository,
} from '@aio-proxy/core';
import { definePlugin, zod, type SyncBackendDefinition } from '@aio-proxy/plugin-sdk';

export const ACCEPTANCE_PLUGIN = '@example/sync-acceptance';
export const ACCEPTANCE_BINDING_PLUGIN_VERSION = '1.0.0';
export const ACCEPTANCE_OAUTH_PROVIDER_ID = 'acceptance-oauth-provider';
export const ACCEPTANCE_OAUTH_OBJECT_ID = 'oauth-account';

export type AcceptanceOAuthCredential = {
  readonly token: string;
  readonly family: string;
};

export type AcceptanceOAuthControls = {
  readonly setOnline: (online: boolean) => void;
  readonly setAllowDetach: (allow: boolean) => void;
  readonly setLoginCredential: (credential: AcceptanceOAuthCredential) => void;
  readonly refreshInputs: () => readonly AcceptanceOAuthCredential[];
  readonly detachChecks: () => readonly {
    readonly shared: AcceptanceOAuthCredential;
    readonly candidate: AcceptanceOAuthCredential;
  }[];
};

type AcceptanceOAuthState = {
  online: boolean;
  allowDetach: boolean;
  loginCredential: AcceptanceOAuthCredential;
  refreshInputs: AcceptanceOAuthCredential[];
  detachChecks: Array<{
    readonly shared: AcceptanceOAuthCredential;
    readonly candidate: AcceptanceOAuthCredential;
  }>;
  refreshCount: number;
};

function acceptanceOAuthCredential(value: unknown): AcceptanceOAuthCredential {
  const record =
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (typeof record['token'] !== 'string' || typeof record['family'] !== 'string')
    throw new Error('acceptance OAuth credential is invalid');
  return { token: record['token'], family: record['family'] };
}

export function createAcceptanceOAuthState(): {
  readonly state: AcceptanceOAuthState;
  readonly controls: AcceptanceOAuthControls;
} {
  const state: AcceptanceOAuthState = {
    online: true,
    allowDetach: true,
    loginCredential: { token: 'acceptance-login-token', family: 'acceptance-family' },
    refreshInputs: [],
    detachChecks: [],
    refreshCount: 0,
  };
  return {
    state,
    controls: {
      setOnline(online) {
        state.online = online;
      },
      setAllowDetach(allow) {
        state.allowDetach = allow;
      },
      setLoginCredential(credential) {
        state.loginCredential = { ...credential };
      },
      refreshInputs: () => state.refreshInputs.map((credential) => ({ ...credential })),
      detachChecks: () =>
        state.detachChecks.map((check) => ({ shared: { ...check.shared }, candidate: { ...check.candidate } })),
    },
  };
}

export function acceptanceDescriptor(
  backend: SyncBackendDefinition<Record<string, never>>,
  oauthState: AcceptanceOAuthState,
): BuiltInPluginDefinition {
  return {
    packageName: ACCEPTANCE_PLUGIN,
    version: ACCEPTANCE_BINDING_PLUGIN_VERSION,
    descriptor: definePlugin(
      (api) => {
        api.sync.register(backend);
        api.oauth.register({
          id: 'acceptance-oauth',
          displayName: 'Acceptance OAuth',
          account: { options: { schema: zod.object({}), form: [] } },
          credentials: zod.object({ token: zod.string(), family: zod.string() }),
          async login() {
            if (!oauthState.online) throw new Error('acceptance OAuth upstream is offline');
            return {
              fingerprint: 'acceptance-oauth-user',
              suggestedKey: ACCEPTANCE_OAUTH_PROVIDER_ID,
              credentials: { ...oauthState.loginCredential },
            };
          },
          catalog: {
            policy: { kind: 'static' },
            async discover() {
              return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
            },
          },
          async createRuntime() {
            return { provider: {} } as never;
          },
          async refreshCredential({ credential }) {
            if (!oauthState.online) throw new Error('acceptance OAuth upstream is offline');
            const current = acceptanceOAuthCredential(credential);
            oauthState.refreshInputs.push(current);
            oauthState.refreshCount += 1;
            return { value: { token: `acceptance-refresh-${oauthState.refreshCount}`, family: current.family } };
          },
          credentialSync: {
            formatVersion: 1,
            multiDevice: { evidenceId: 'acceptance-oauth-evidence' },
            canDetach: async ({ shared, candidate }) => {
              if (!oauthState.online) throw new Error('acceptance OAuth upstream is offline');
              const sharedCredential = acceptanceOAuthCredential(shared);
              const candidateCredential = acceptanceOAuthCredential(candidate);
              oauthState.detachChecks.push({ shared: sharedCredential, candidate: candidateCredential });
              return oauthState.allowDetach && sharedCredential.family !== candidateCredential.family;
            },
          },
        });
      },
      {
        options: {
          schema: zod.object({ endpoint: zod.url().optional(), token: zod.string().optional() }),
          form: [
            { type: 'text', key: 'endpoint', label: 'Endpoint' },
            { type: 'secret', key: 'token', label: 'Token' },
          ],
        },
      },
    ),
  };
}

export function seedAcceptanceOAuth(input: {
  readonly binding: LocalBinding;
  readonly repository: SyncRepository;
  readonly accounts: PluginRepository;
  readonly credential: AcceptanceOAuthCredential;
  readonly shared: boolean;
}): void {
  const entity: LocalEntity = {
    objectId: ACCEPTANCE_OAUTH_OBJECT_ID,
    logicalKey: ACCEPTANCE_OAUTH_PROVIDER_ID,
    kind: 'provider',
    mode: 'included',
    epoch: 0,
    desired: null,
    baseline: null,
    overrides: [],
    pendingReason: null,
    ...(input.shared
      ? {
          oauth: {
            mode: 'shared' as const,
            epoch: 0,
            generation: 0,
            localRevision: 1,
            pluginVersion: ACCEPTANCE_BINDING_PLUGIN_VERSION,
            formatVersion: 1,
            multiDeviceEvidenceId: 'acceptance-oauth-evidence',
          },
        }
      : {}),
  };
  input.repository.putEntity(input.binding.id, entity);
  const account = input.accounts.stageAccountOperation({
    kind: 'create',
    targetDigest: `acceptance-oauth-${input.binding.deviceId}`,
    account: {
      providerId: ACCEPTANCE_OAUTH_PROVIDER_ID,
      plugin: ACCEPTANCE_PLUGIN,
      capability: 'acceptance-oauth',
      fingerprint: 'acceptance-oauth-user',
      options: {},
      secrets: {},
      credential: input.credential,
      catalog: {
        kind: 'replace',
        value: {
          catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
          refreshedAt: 0,
        },
      },
    },
  });
  input.accounts.completeAccountOperation(account.operationId);
}
