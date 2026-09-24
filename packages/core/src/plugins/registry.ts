import { createLogger } from '@aio-proxy/logger';
import {
  type LocalizedText,
  LocalizedTextSchema,
  type Logger,
  type LogicalRequestContext,
  type OAuthAdapter,
  type PluginApi,
  type RawTransport,
} from '@aio-proxy/plugin-sdk';
import { isRecord } from '@aio-proxy/shared';
import { CapabilityIdSchema } from '@aio-proxy/types';

import { validateConfigSpec } from './config-spec/index';
import { isPluginZodSchema } from './schema';

export type PluginRegistry = {
  readonly resolveOAuth: (plugin: string, capability: string) => OAuthAdapter | undefined;
  readonly resolveResponsesRaw: (plugin: string) => ResponsesRawWrap | undefined;
  readonly oauthCapabilities: () => readonly {
    readonly plugin: string;
    readonly capability: string;
    readonly adapter: OAuthAdapter;
  }[];
};

export type ResponsesRawWrap = (input: {
  readonly original: RawTransport['invoke'];
  readonly evaluate?: (input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly body: unknown;
    readonly signal: AbortSignal;
    readonly logicalRequest: LogicalRequestContext;
  }) => Promise<unknown>;
}) => RawTransport['invoke'];

export type BuiltInPluginApi = PluginApi & {
  readonly raw: {
    readonly wrap: (protocol: 'openai-response', wrap: ResponsesRawWrap) => void;
  };
};

type OAuthCapability = ReturnType<PluginRegistry['oauthCapabilities']>[number];

function validateQuota(value: unknown): NonNullable<OAuthAdapter['quota']> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Invalid OAuth adapter');
  const { read, reset } = value;
  if (typeof read !== 'function' || (reset !== undefined && typeof reset !== 'function')) {
    throw new Error('Invalid OAuth adapter');
  }
  const boundRead = read.bind(value) as NonNullable<OAuthAdapter['quota']>['read'];
  if (reset === undefined) return { read: boundRead };
  return {
    read: boundRead,
    reset: reset.bind(value) as NonNullable<NonNullable<OAuthAdapter['quota']>['reset']>,
  };
}

function validateCredentialImports(value: unknown): OAuthAdapter['credentialImports'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Invalid OAuth adapter');
  const cpa = value['cpa'];
  if (cpa === undefined) return {};
  if (!isRecord(cpa)) throw new Error('Invalid OAuth adapter');
  const types = cpa['types'];
  const importCredential = cpa['import'];
  if (!Array.isArray(types) || types.length === 0 || typeof importCredential !== 'function') {
    throw new Error('Invalid OAuth adapter');
  }
  const validatedTypes: string[] = [];
  for (const type of types) {
    if (typeof type !== 'string' || type === '' || type !== type.trim() || validatedTypes.includes(type)) {
      throw new Error('Invalid OAuth adapter');
    }
    validatedTypes.push(type);
  }
  return {
    cpa: {
      types: validatedTypes as [string, ...string[]],
      import: importCredential.bind(cpa) as NonNullable<
        NonNullable<OAuthAdapter['credentialImports']>['cpa']
      >['import'],
    },
  };
}

function validateAdapter(value: unknown): { readonly id: string; readonly adapter: OAuthAdapter } {
  if (!isRecord(value)) throw new Error('Invalid OAuth adapter');
  const {
    id: rawId,
    displayName,
    description,
    supportsProxy,
    account,
    credentials,
    login,
    createRuntime,
    catalog,
    quota,
    credentialImports,
    refreshCredential,
  } = value;
  const id = CapabilityIdSchema.parse(rawId);
  const validatedDisplayName = LocalizedTextSchema.safeParse(displayName);
  const validatedDescription = LocalizedTextSchema.safeParse(description);
  if (!validatedDisplayName.success || (description !== undefined && !validatedDescription.success)) {
    throw new Error('Invalid OAuth adapter');
  }
  if (supportsProxy !== undefined && typeof supportsProxy !== 'boolean') throw new Error('Invalid OAuth adapter');
  if (!isRecord(account)) throw new Error('Invalid OAuth adapter');
  const { options } = account;
  const validatedOptions = validateConfigSpec(options).spec;
  if (!isPluginZodSchema(credentials)) throw new Error('Invalid OAuth adapter');
  if (typeof login !== 'function' || typeof createRuntime !== 'function') throw new Error('Invalid OAuth adapter');
  if (refreshCredential !== undefined && typeof refreshCredential !== 'function') {
    throw new Error('Invalid OAuth adapter');
  }
  const validatedQuota = validateQuota(quota);
  const validatedCredentialImports = validateCredentialImports(credentialImports);
  if (!isRecord(catalog)) throw new Error('Invalid OAuth adapter');
  const { discover, policy, initialFallback, defaultAliases } = catalog;
  if (
    typeof discover !== 'function' ||
    !isRecord(policy) ||
    (initialFallback !== undefined && typeof initialFallback !== 'function') ||
    (defaultAliases !== undefined && typeof defaultAliases !== 'function')
  ) {
    throw new Error('Invalid OAuth adapter');
  }
  const { kind, ttlMs } = policy;
  if (kind !== 'static') {
    if (
      kind !== 'ttl' ||
      typeof ttlMs !== 'number' ||
      !Number.isFinite(ttlMs) ||
      !Number.isInteger(ttlMs) ||
      ttlMs <= 0
    ) {
      throw new Error('Invalid OAuth adapter');
    }
  }
  return {
    id,
    adapter: {
      id,
      displayName: validatedDisplayName.data,
      ...(description === undefined ? {} : { description: validatedDescription.data as LocalizedText }),
      ...(supportsProxy === undefined ? {} : { supportsProxy }),
      account: { options: validatedOptions },
      credentials: credentials as OAuthAdapter['credentials'],
      login: login.bind(value) as OAuthAdapter['login'],
      catalog: {
        policy: policy as OAuthAdapter['catalog']['policy'],
        discover: discover.bind(catalog) as OAuthAdapter['catalog']['discover'],
        ...(initialFallback === undefined
          ? {}
          : {
              initialFallback: initialFallback.bind(catalog) as NonNullable<OAuthAdapter['catalog']['initialFallback']>,
            }),
        ...(defaultAliases === undefined
          ? {}
          : { defaultAliases: defaultAliases.bind(catalog) as NonNullable<OAuthAdapter['catalog']['defaultAliases']> }),
      },
      createRuntime: createRuntime.bind(value) as OAuthAdapter['createRuntime'],
      ...(validatedQuota === undefined ? {} : { quota: validatedQuota }),
      ...(validatedCredentialImports === undefined ? {} : { credentialImports: validatedCredentialImports }),
      ...(refreshCredential === undefined
        ? {}
        : { refreshCredential: refreshCredential.bind(value) as NonNullable<OAuthAdapter['refreshCredential']> }),
    },
  };
}

export type PluginStagingRegistry = {
  readonly api: BuiltInPluginApi;
  readonly seal: () => void;
  readonly commit: () => void;
};

export type PluginLoggerFactory = (
  category: readonly string[],
  options?: { readonly redactSecretValues?: readonly string[] },
) => Logger;

export type PluginStagingOptions = {
  readonly redactSecretValues?: readonly string[];
  readonly builtIn?: boolean;
};

export function createPluginRegistryHost(createPluginLogger: PluginLoggerFactory = createLogger): {
  readonly registry: PluginRegistry;
  readonly stage: (plugin: string, options?: PluginStagingOptions) => PluginStagingRegistry;
} {
  const committed = new Map<string, OAuthCapability>();
  const committedCpaTypes = new Map<string, string>();
  const responsesRaw = new Map<string, ResponsesRawWrap>();
  const registry: PluginRegistry = {
    resolveOAuth(plugin, capability) {
      return committed.get(`${plugin}\0${capability}`)?.adapter;
    },
    resolveResponsesRaw(plugin) {
      return responsesRaw.get(plugin);
    },
    oauthCapabilities() {
      return [...committed.values()];
    },
  };

  return {
    registry,
    stage(plugin, options = {}) {
      const staged = new Map<string, OAuthCapability>();
      const stagedCpaTypes = new Set<string>();
      let stagedResponsesRaw: ResponsesRawWrap | undefined;
      let sealed = false;
      const api = {
        logger: createPluginLogger(['aio-proxy', 'plugin', plugin], options),
        oauth: {
          register(value) {
            if (sealed) throw new Error('Plugin staging registry is sealed');
            const { id, adapter } = validateAdapter(value);
            if (staged.has(id)) throw new Error('Duplicate OAuth capability');
            for (const type of adapter.credentialImports?.cpa?.types ?? []) {
              if (stagedCpaTypes.has(type) || committedCpaTypes.has(type)) {
                throw new Error(`Duplicate OAuth credential import type: ${type}`);
              }
              stagedCpaTypes.add(type);
            }
            staged.set(id, { plugin, capability: id, adapter });
          },
        },
        ...(options.builtIn
          ? {
              raw: {
                wrap(protocol: 'openai-response', wrap: ResponsesRawWrap) {
                  if (sealed) throw new Error('Plugin staging registry is sealed');
                  if (protocol !== 'openai-response') throw new Error('Unsupported raw wrapper protocol');
                  if (stagedResponsesRaw !== undefined) throw new Error('Duplicate responses raw wrapper');
                  stagedResponsesRaw = wrap;
                },
              },
            }
          : {}),
      } as BuiltInPluginApi;
      return {
        api,
        seal() {
          sealed = true;
        },
        commit() {
          if (!sealed) throw new Error('Plugin staging registry must be sealed before commit');
          for (const capability of staged.values()) {
            committed.set(`${plugin}\0${capability.capability}`, capability);
            for (const type of capability.adapter.credentialImports?.cpa?.types ?? []) {
              committedCpaTypes.set(type, `${plugin}#${capability.capability}`);
            }
          }
          if (stagedResponsesRaw !== undefined) responsesRaw.set(plugin, stagedResponsesRaw);
        },
      };
    },
  };
}
