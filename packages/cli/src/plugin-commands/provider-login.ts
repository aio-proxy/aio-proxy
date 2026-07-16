import {
  AccountCleanupPendingError,
  AccountOptionsValidationError,
  AtomicConfigFile,
  configPath,
  createEmbeddedBuiltIns,
  createPluginRepository,
  type DiagnosticFactory,
  type LoginOAuthAccountOptions,
  type LoginOAuthAccountResult,
  loadPluginRegistry,
  loginOAuthAccount,
  type OAuthCapabilityReference,
  OAuthCapabilityRequiredError,
  OAuthCapabilityUnavailableError,
  OAuthLoginResultValidationError,
  OAuthLoginTimeoutError,
  type PluginLogSink,
  type PluginRegistry,
  type PluginRepository,
  ProviderAccountAlreadyExistsError,
  ProviderAccountChangedError,
  ProviderCapabilityTargetMismatchError,
  ProviderConfigInvalidError,
  ProviderFingerprintMismatchError,
  ProviderIdCollisionError,
  recoverPendingAccountOperations,
} from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { getLocale, m } from "@aio-proxy/i18n";
import {
  type AuthorizationPort,
  type LocalizedText,
  LocalizedTextSchema,
  resolveLocalizedText,
} from "@aio-proxy/plugin-sdk";
import { providerLoginCommand } from "@aio-proxy/types";
import { confirm, input, password, select } from "@inquirer/prompts";
import { openBrowser } from "../open-browser";
import { createCliAuthorizationPort, createDefaultCliAuthorizationCopy } from "./authorization";
import { type PluginFormPrompts, renderConfigSpec } from "./form";
import { isLoopbackUserError } from "./loopback";
import { createCliPluginDiagnosticFactory } from "./plugin";

type ConfigRecord = Record<string, unknown>;

export type ProviderLoginOptions = { readonly provider?: string };

type CapabilityChoice = { readonly reference: string; readonly label: LocalizedText };

export type ProviderLoginDeps = {
  readonly config: AtomicConfigFile;
  readonly repository: PluginRepository;
  readonly registry: PluginRegistry;
  readonly isTTY: boolean;
  readonly selectCapability: (choices: readonly CapabilityChoice[]) => Promise<string>;
  readonly renderAccountOptions: LoginOAuthAccountOptions["renderAccountOptions"];
  readonly createAuthorization: (signal: AbortSignal) => AuthorizationPort;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly recover?: typeof recoverPendingAccountOperations;
  readonly login?: (options: LoginOAuthAccountOptions) => Promise<LoginOAuthAccountResult>;
  readonly print: (line: string) => void;
  readonly close?: () => void;
};

export class ProviderCapabilityNotFoundError extends Error {
  override readonly name = "ProviderCapabilityNotFoundError";

  constructor(readonly reference?: string) {
    super(
      reference === undefined
        ? m.cli_provider_login_error_capability_not_found_any()
        : m.cli_provider_login_error_capability_not_found({ reference }),
    );
  }
}

export class ProviderCapabilityAmbiguousError extends Error {
  override readonly name = "ProviderCapabilityAmbiguousError";

  constructor(
    readonly input: string,
    readonly references: readonly string[],
  ) {
    const joined = references.join(", ");
    super(
      input.length === 0
        ? m.cli_provider_login_error_capability_ambiguous_selection({ references: joined })
        : m.cli_provider_login_error_capability_ambiguous({ input, references: joined }),
    );
  }
}

export class ProviderCapabilityMismatchError extends Error {
  override readonly name = "ProviderCapabilityMismatchError";

  constructor(
    readonly requested: string,
    readonly target: string,
  ) {
    super(m.cli_provider_login_error_capability_mismatch({ requested, target }));
  }
}

export class ProviderTargetNotFoundError extends Error {
  override readonly name = "ProviderTargetNotFoundError";

  constructor(readonly providerId: string) {
    super(m.cli_provider_login_error_target_not_found({ provider: providerId }));
  }
}

export class ProviderTargetInvalidError extends Error {
  override readonly name = "ProviderTargetInvalidError";

  constructor(readonly providerId: string) {
    super(m.cli_provider_login_error_target_invalid({ provider: providerId }));
  }
}

type CapabilitySelectPrompt = (config: {
  readonly message: string;
  readonly choices: readonly { readonly name: string; readonly value: string }[];
}) => Promise<string>;

export function createCapabilitySelector(
  prompt: CapabilitySelectPrompt = select as CapabilitySelectPrompt,
): (choices: readonly CapabilityChoice[]) => Promise<string> {
  return (choices) =>
    prompt({
      message: m.cli_provider_login_capability_prompt(),
      choices: choices.map(({ reference, label }) => ({
        name: resolveLocalizedText(label, getLocale()),
        value: reference,
      })),
    });
}

export function createManualOnlyConfirmation(
  signal: AbortSignal,
  prompt: typeof confirm = confirm,
): (redirectUri: string) => Promise<boolean> {
  return (redirectUri) => prompt({ message: redirectUri, default: false }, { signal });
}

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(reference: OAuthCapabilityReference): string {
  return `${reference.plugin}#${reference.capability}`;
}

function parseCanonical(value: string): OAuthCapabilityReference | null {
  const separator = value.lastIndexOf("#");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { plugin: value.slice(0, separator), capability: value.slice(separator + 1) };
}

function allCapabilities(
  registry: PluginRegistry,
): readonly (OAuthCapabilityReference & { readonly label: LocalizedText })[] {
  return registry
    .oauthCapabilities()
    .map(({ plugin, capability, adapter }) => ({ plugin, capability, label: adapter.label }))
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

async function choose(
  inputValue: string | undefined,
  registry: PluginRegistry,
  deps: Pick<ProviderLoginDeps, "isTTY" | "selectCapability">,
): Promise<OAuthCapabilityReference> {
  const available = allCapabilities(registry);
  let candidates: ReturnType<typeof allCapabilities>;
  if (inputValue === undefined) {
    candidates = available;
  } else {
    const exact = parseCanonical(inputValue);
    if (exact !== null) {
      if (registry.resolveOAuth(exact.plugin, exact.capability) === undefined) {
        throw new ProviderCapabilityNotFoundError(inputValue);
      }
      return exact;
    }
    candidates = available.filter(({ capability }) => capability === inputValue);
  }
  if (candidates.length === 0) throw new ProviderCapabilityNotFoundError(inputValue);
  if (candidates.length === 1 && inputValue !== undefined) return candidates[0] as OAuthCapabilityReference;
  const references = candidates.map(canonical);
  if (!deps.isTTY) {
    if (candidates.length === 1) return candidates[0] as OAuthCapabilityReference;
    throw new ProviderCapabilityAmbiguousError(inputValue ?? "", references);
  }
  const selected = await deps.selectCapability(
    candidates.map((candidate) => ({ reference: canonical(candidate), label: candidate.label })),
  );
  const resolved = parseCanonical(selected);
  if (
    resolved === null ||
    !candidates.some(
      (candidate) => candidate.plugin === resolved.plugin && candidate.capability === resolved.capability,
    )
  ) {
    throw new ProviderCapabilityNotFoundError(selected);
  }
  return resolved;
}

async function targetCapability(providerId: string, config: AtomicConfigFile): Promise<OAuthCapabilityReference> {
  return config.transaction(async (current) => {
    const providers = isRecord(current["providers"]) ? current["providers"] : {};
    const entry = providers[providerId];
    if (entry === undefined) {
      throw new ProviderTargetNotFoundError(providerId);
    }
    if (
      !isRecord(entry) ||
      entry["kind"] !== "oauth" ||
      Object.hasOwn(entry, "vendor") ||
      typeof entry["plugin"] !== "string" ||
      typeof entry["capability"] !== "string"
    ) {
      throw new ProviderTargetInvalidError(providerId);
    }
    return {
      next: current,
      result: { plugin: entry["plugin"], capability: entry["capability"] },
    };
  });
}

function enablements(config: ConfigRecord): readonly { readonly packageName: string; readonly options?: unknown }[] {
  if (!Array.isArray(config["plugins"])) return [];
  return config["plugins"].flatMap((entry) => {
    if (typeof entry === "string") return [{ packageName: entry }];
    if (Array.isArray(entry) && typeof entry[0] === "string") {
      return [{ packageName: entry[0], ...(entry.length < 2 ? {} : { options: entry[1] }) }];
    }
    return [];
  });
}

export type ProviderLoginDefaultDepsOptions = {
  readonly config?: AtomicConfigFile;
  readonly openDatabase?: typeof openDb;
  readonly createRepository?: typeof createPluginRepository;
  readonly loadRegistry?: typeof loadPluginRegistry;
};

export async function createProviderLoginDefaultDeps(
  options: ProviderLoginDefaultDepsOptions = {},
): Promise<ProviderLoginDeps> {
  const config = options.config ?? new AtomicConfigFile(configPath());
  const handle = (options.openDatabase ?? openDb)();
  try {
    const repository = (options.createRepository ?? createPluginRepository)(handle.sqlite);
    const diagnostics = createCliPluginDiagnosticFactory();
    const snapshot = await (options.loadRegistry ?? loadPluginRegistry)({
      enablements: enablements(await config.read()),
      builtIns: createEmbeddedBuiltIns(),
      diagnostics,
      importPackage: async ({ entrypoint }) => import(entrypoint),
      logger: () => {},
      secrets: { readPluginSecret: (plugin) => repository.readPluginSecret(plugin)?.value },
    });
    const prompts: PluginFormPrompts = { input, password, confirm, select };
    return {
      config,
      repository,
      registry: snapshot.registry,
      isTTY: process.stdin.isTTY === true,
      selectCapability: createCapabilitySelector(),
      renderAccountOptions: ({ spec, currentPublicValues, currentSecrets, signal }) =>
        renderConfigSpec(spec, { prompts, currentPublicValues, currentSecrets, signal }),
      createAuthorization: (signal) =>
        createCliAuthorizationPort({
          copy: createDefaultCliAuthorizationCopy(),
          openBrowser,
          copyToClipboard: () => false,
          print: console.log,
          readManualCallbackUrl: (authorizationUrl, promptSignal) =>
            input({ message: authorizationUrl }, { signal: promptSignal }),
          confirmManualOnly: createManualOnlyConfirmation(signal),
          signal,
        }),
      diagnostics,
      logger: () => {},
      print: console.log,
      close: () => handle.close(),
    };
  } catch (error) {
    try {
      handle.close();
    } catch {}
    throw error;
  }
}

const providerLoginPresentationErrors = new WeakSet<Error>();

function safeText(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > 256) return null;
  return value.replaceAll(/[\p{Cc}\p{Cf}]/gu, "�");
}

function safeIdentifier(value: unknown): string | null {
  return safeText(value);
}

function safeProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function safeCapability(value: unknown): OAuthCapabilityReference | null {
  if (!isRecord(value)) return null;
  const plugin = safeIdentifier(safeProperty(value, "plugin"));
  const capability = safeIdentifier(safeProperty(value, "capability"));
  return plugin === null || capability === null ? null : { plugin, capability };
}

function presentationError(message: string): Error {
  const presented = new Error(message);
  presented.name = "ProviderLoginPresentationError";
  providerLoginPresentationErrors.add(presented);
  return presented;
}

function presentProviderLoginUserError(error: unknown): Error | null {
  if (error instanceof ProviderAccountAlreadyExistsError) {
    const provider = safeIdentifier(safeProperty(error, "existingProviderId"));
    if (provider === null) return null;
    return presentationError(
      m.cli_provider_login_error_account_exists({ provider, command: providerLoginCommand(provider) }),
    );
  } else if (error instanceof AccountCleanupPendingError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_cleanup_pending({ provider }));
  } else if (error instanceof ProviderAccountChangedError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_account_changed({ provider }));
  } else if (error instanceof ProviderFingerprintMismatchError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_fingerprint_mismatch({ provider }));
  } else if (error instanceof ProviderCapabilityTargetMismatchError) {
    const requested = safeCapability(safeProperty(error, "requested"));
    const target = safeCapability(safeProperty(error, "target"));
    return requested === null || target === null
      ? null
      : presentationError(
          m.cli_provider_login_error_target_mismatch({
            requested: canonical(requested),
            target: canonical(target),
          }),
        );
  } else if (error instanceof OAuthLoginResultValidationError) {
    return presentationError(m.cli_provider_login_error_result_invalid());
  } else if (error instanceof AccountOptionsValidationError) {
    return presentationError(m.cli_provider_login_error_options_invalid());
  } else if (error instanceof ProviderConfigInvalidError) {
    return presentationError(m.cli_provider_login_error_config_invalid());
  } else if (error instanceof OAuthLoginTimeoutError) {
    return presentationError(m.cli_provider_login_error_timeout());
  } else if (error instanceof OAuthCapabilityRequiredError) {
    return presentationError(m.cli_provider_login_error_capability_required());
  } else if (error instanceof OAuthCapabilityUnavailableError) {
    const reference = safeCapability(error);
    return reference === null
      ? null
      : presentationError(m.cli_provider_login_error_capability_unavailable({ reference: canonical(reference) }));
  } else if (error instanceof ProviderIdCollisionError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_provider_id_collision({ provider }));
  } else if (error instanceof ProviderCapabilityNotFoundError) {
    const reference = safeProperty(error, "reference");
    if (reference === undefined) return presentationError(m.cli_provider_login_error_capability_not_found_any());
    const safeReference = safeIdentifier(reference);
    return safeReference === null
      ? null
      : presentationError(m.cli_provider_login_error_capability_not_found({ reference: safeReference }));
  } else if (error instanceof ProviderCapabilityAmbiguousError) {
    const inputValue = safeText(safeProperty(error, "input"), true);
    const rawReferences = safeProperty(error, "references");
    if (inputValue === null || !Array.isArray(rawReferences) || rawReferences.length > 32) return null;
    const references = rawReferences.map(safeIdentifier);
    if (references.some((reference) => reference === null)) return null;
    const joined = (references as string[]).join(", ");
    return presentationError(
      inputValue.length === 0
        ? m.cli_provider_login_error_capability_ambiguous_selection({ references: joined })
        : m.cli_provider_login_error_capability_ambiguous({ input: inputValue, references: joined }),
    );
  } else if (error instanceof ProviderCapabilityMismatchError) {
    const requested = safeIdentifier(safeProperty(error, "requested"));
    const target = safeIdentifier(safeProperty(error, "target"));
    return requested === null || target === null
      ? null
      : presentationError(m.cli_provider_login_error_capability_mismatch({ requested, target }));
  } else if (error instanceof ProviderTargetNotFoundError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_target_not_found({ provider }));
  } else if (error instanceof ProviderTargetInvalidError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_target_invalid({ provider }));
  }
  return null;
}

export function isProviderLoginUserError(error: unknown): error is Error {
  return isLoopbackUserError(error) || (error instanceof Error && providerLoginPresentationErrors.has(error));
}

export async function providerLogin(
  capabilityInput: string | undefined,
  options: ProviderLoginOptions,
  injected?: ProviderLoginDeps,
): Promise<void> {
  const deps = injected ?? (await createProviderLoginDefaultDeps());
  try {
    await (deps.recover ?? recoverPendingAccountOperations)(deps.config, deps.repository, { mode: "cli" });
    const target = options.provider === undefined ? undefined : await targetCapability(options.provider, deps.config);
    if (target !== undefined && deps.registry.resolveOAuth(target.plugin, target.capability) === undefined) {
      throw new ProviderCapabilityNotFoundError(canonical(target));
    }
    const resolved =
      capabilityInput === undefined && target !== undefined
        ? target
        : await choose(capabilityInput, deps.registry, deps);
    if (target !== undefined && (target.plugin !== resolved.plugin || target.capability !== resolved.capability)) {
      throw new ProviderCapabilityMismatchError(canonical(resolved), canonical(target));
    }
    const result = await (deps.login ?? loginOAuthAccount)({
      ...(options.provider === undefined ? {} : { targetProviderId: options.provider }),
      capability: resolved,
      registry: deps.registry,
      repository: deps.repository,
      config: deps.config,
      renderAccountOptions: deps.renderAccountOptions,
      createAuthorization: deps.createAuthorization,
      diagnostics: deps.diagnostics,
      logger: deps.logger,
      progress: (message) => {
        const parsed = LocalizedTextSchema.safeParse(message);
        if (parsed.success) deps.print(resolveLocalizedText(parsed.data, getLocale()));
      },
    });
    deps.print(result.providerId);
  } catch (error) {
    throw presentProviderLoginUserError(error) ?? error;
  } finally {
    if (injected === undefined) deps.close?.();
  }
}
