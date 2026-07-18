import {
  type CreateCredentialPortOptions,
  collectSecretStrings,
  createCredentialPort,
  type DiagnosticFactory,
  type PluginLogSink,
  type PluginRegistrySnapshot,
  type PluginRepository,
  PluginSchemaContractError,
  parsePluginSchema,
  type StoredAccount,
  validateConfigSpec,
} from "@aio-proxy/core";
import type { CredentialPort, OAuthAdapter } from "@aio-proxy/plugin-sdk";
import type { DiagnosticCode, OAuthProvider } from "@aio-proxy/types";
import { isPlainObject } from "es-toolkit/predicate";

export type OAuthAccountSummary = {
  readonly accountLabel?: string;
  readonly expiresAt?: number;
};

export class OAuthPluginAccountPreparationError extends Error {
  constructor(
    readonly code: DiagnosticCode,
    readonly accountSummary: OAuthAccountSummary,
    readonly suggestLogin: boolean,
  ) {
    super("OAuth plugin account is unavailable");
    this.name = "OAuthPluginAccountPreparationError";
  }
}

type PreparedOAuthAccountBase = {
  readonly adapter: OAuthAdapter;
  readonly accountOptions: unknown;
  readonly accountSummary: OAuthAccountSummary;
  readonly createCredentials: () => CredentialPort<unknown>;
};

export type PreparedOAuthPluginAccount = PreparedOAuthAccountBase & {
  readonly credentialMode: "runtime";
  readonly account: StoredAccount;
  readonly accountOptionsIdentity: { readonly public: unknown; readonly secret: unknown };
};

export type PreparedOAuthControlPlaneAccount = PreparedOAuthAccountBase & {
  readonly credentialMode: "control-plane";
  readonly secretValues: readonly string[];
};

type PrepareOAuthPluginAccountBaseOptions = {
  readonly config: OAuthProvider;
  readonly plugins: PluginRegistrySnapshot;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly onDiagnosticChanged: () => void;
};

export type PrepareOAuthPluginAccountOptions = PrepareOAuthPluginAccountBaseOptions &
  (
    | {
        readonly credentialMode?: "runtime";
        readonly pluginSecrets?: unknown;
        readonly pluginSecretValues?: never;
      }
    | {
        readonly credentialMode: "control-plane";
        readonly pluginSecrets?: never;
        readonly pluginSecretValues?: readonly string[];
      }
  );

function unavailable(
  code: DiagnosticCode,
  accountSummary: OAuthAccountSummary = {},
  suggestLogin = false,
): OAuthPluginAccountPreparationError {
  return new OAuthPluginAccountPreparationError(code, accountSummary, suggestLogin);
}

function credentialFactory(
  options: CreateCredentialPortOptions<unknown>,
): PreparedOAuthAccountBase["createCredentials"] {
  return () => createCredentialPort(options);
}

export function prepareOAuthPluginAccount(
  options: PrepareOAuthPluginAccountBaseOptions & {
    readonly credentialMode: "control-plane";
    readonly pluginSecrets?: never;
    readonly pluginSecretValues?: readonly string[];
  },
): Promise<PreparedOAuthControlPlaneAccount>;
export function prepareOAuthPluginAccount(
  options: PrepareOAuthPluginAccountBaseOptions & {
    readonly credentialMode?: "runtime";
    readonly pluginSecrets?: unknown;
    readonly pluginSecretValues?: never;
  },
): Promise<PreparedOAuthPluginAccount>;

export async function prepareOAuthPluginAccount(
  options: PrepareOAuthPluginAccountOptions,
): Promise<PreparedOAuthPluginAccount | PreparedOAuthControlPlaneAccount> {
  const { config, plugins, repository } = options;
  const loaded = plugins.plugins.get(config.plugin);
  if (loaded === undefined || loaded.state.status === "failed") {
    throw unavailable(loaded?.state.status === "failed" ? loaded.state.diagnostic.code : "PLUGIN_NOT_INSTALLED");
  }

  const adapter = plugins.registry.resolveOAuth(config.plugin, config.capability);
  if (adapter === undefined) throw unavailable("CAPABILITY_MISSING");

  let account: StoredAccount | null;
  try {
    account = repository.readAccount(config.id);
  } catch {
    throw unavailable("CREDENTIALS_MISSING_OR_INVALID", {}, true);
  }
  if (account === null || account.plugin !== config.plugin || account.capability !== config.capability) {
    throw unavailable("CREDENTIALS_MISSING_OR_INVALID");
  }

  const accountSummary = {
    ...(account.label === undefined ? {} : { accountLabel: account.label }),
    ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
  };

  const publicOptions = config.options ?? {};
  let accountOptions: unknown;
  let accountOptionsIdentity: PreparedOAuthPluginAccount["accountOptionsIdentity"];
  try {
    const { secretKeys } = validateConfigSpec(adapter.account.options);
    if (!isPlainObject(publicOptions) || !isPlainObject(account.secrets)) throw new Error("Invalid account options");
    for (const key of secretKeys) if (Object.hasOwn(publicOptions, key)) throw new Error("Secret option in config");
    accountOptionsIdentity = structuredClone({ public: publicOptions, secret: account.secrets });
    const parsed = await parsePluginSchema(adapter.account.options.schema, { ...publicOptions, ...account.secrets });
    if (!parsed.ok) throw new Error("Invalid account options");
    accountOptions = parsed.value;
  } catch {
    throw unavailable("ACCOUNT_OPTIONS_INVALID", accountSummary, true);
  }

  let parsedCredential: Awaited<ReturnType<typeof parsePluginSchema>>;
  try {
    parsedCredential = await parsePluginSchema(adapter.credentials, account.credential);
  } catch (error) {
    if (error instanceof PluginSchemaContractError) throw unavailable("PLUGIN_LOAD_FAILED", accountSummary);
    throw error;
  }
  if (!parsedCredential.ok) throw unavailable("CREDENTIALS_MISSING_OR_INVALID", accountSummary, true);

  const credentialBase = {
    providerId: config.id,
    schema: adapter.credentials,
    repository,
    diagnostics: options.diagnostics,
    logger: options.logger,
    onDiagnosticChanged: options.onDiagnosticChanged,
    onCredentialChanged: options.onDiagnosticChanged,
  };
  if (options.credentialMode === "control-plane") {
    const pluginSecretValues = [...(options.pluginSecretValues ?? [])];
    return {
      credentialMode: "control-plane",
      adapter,
      accountOptions,
      accountSummary,
      secretValues: collectSecretStrings([account.credential, account.secrets, accountOptions, pluginSecretValues]),
      createCredentials: credentialFactory({
        ...credentialBase,
        mode: "control-plane",
        pluginSecretValues,
      }),
    };
  }
  return {
    credentialMode: "runtime",
    adapter,
    account,
    accountOptions,
    accountOptionsIdentity,
    accountSummary,
    createCredentials: credentialFactory({
      ...credentialBase,
      mode: "runtime",
      ...(options.pluginSecrets === undefined ? {} : { pluginSecrets: options.pluginSecrets }),
    }),
  };
}
