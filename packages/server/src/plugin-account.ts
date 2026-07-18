import {
  type CredentialPortMode,
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

export type PreparedOAuthPluginAccount = {
  readonly adapter: OAuthAdapter;
  readonly account: StoredAccount;
  readonly accountOptions: unknown;
  readonly accountOptionsIdentity: { readonly public: unknown; readonly secret: unknown };
  readonly accountSummary: OAuthAccountSummary;
  readonly createCredentials: () => CredentialPort<unknown>;
};

type PrepareOAuthPluginAccountOptions = {
  readonly config: OAuthProvider;
  readonly plugins: PluginRegistrySnapshot;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly credentialMode?: CredentialPortMode;
  readonly onDiagnosticChanged: () => void;
  readonly pluginSecrets?: unknown;
};

function unavailable(
  code: DiagnosticCode,
  accountSummary: OAuthAccountSummary = {},
  suggestLogin = false,
): OAuthPluginAccountPreparationError {
  return new OAuthPluginAccountPreparationError(code, accountSummary, suggestLogin);
}

export async function prepareOAuthPluginAccount(
  options: PrepareOAuthPluginAccountOptions,
): Promise<PreparedOAuthPluginAccount> {
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

  return {
    adapter,
    account,
    accountOptions,
    accountOptionsIdentity,
    accountSummary,
    createCredentials: () =>
      createCredentialPort({
        providerId: config.id,
        schema: adapter.credentials,
        repository,
        diagnostics: options.diagnostics,
        logger: options.logger,
        ...(options.credentialMode === undefined ? {} : { mode: options.credentialMode }),
        onDiagnosticChanged: options.onDiagnosticChanged,
        onCredentialChanged: options.onDiagnosticChanged,
        pluginSecrets: options.pluginSecrets,
      }) as CredentialPort<unknown>,
  };
}
