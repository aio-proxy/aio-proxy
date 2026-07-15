import {
  AccountCleanupPendingError,
  AtomicConfigFile,
  configPath,
  createPluginRepository,
  type DiagnosticFactory,
  type LoginOAuthAccountOptions,
  type LoginOAuthAccountResult,
  loadPluginRegistry,
  loginOAuthAccount,
  type OAuthCapabilityReference,
  type PluginLogSink,
  type PluginRegistry,
  type PluginRepository,
  ProviderAccountAlreadyExistsError,
  recoverPendingAccountOperations,
} from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import type { AuthorizationPort } from "@aio-proxy/plugin-sdk";
import { confirm, input, password, select } from "@inquirer/prompts";
import { openBrowser } from "../browser";
import { createCliAuthorizationPort, createDefaultCliAuthorizationCopy } from "./authorization";
import { type PluginFormPrompts, renderConfigSpec } from "./form";
import { createCliPluginDiagnosticFactory } from "./plugin";

type ConfigRecord = Record<string, unknown>;

export type ProviderLoginOptions = { readonly provider?: string };

export type ProviderLoginDeps = {
  readonly config: AtomicConfigFile;
  readonly repository: PluginRepository;
  readonly registry: PluginRegistry;
  readonly isTTY: boolean;
  readonly selectCapability: (references: readonly string[]) => Promise<string>;
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
    super("OAuth capability was not found");
  }
}

export class ProviderCapabilityAmbiguousError extends Error {
  override readonly name = "ProviderCapabilityAmbiguousError";

  constructor(
    readonly input: string,
    readonly references: readonly string[],
  ) {
    super("OAuth capability is ambiguous");
  }
}

export class ProviderCapabilityMismatchError extends Error {
  override readonly name = "ProviderCapabilityMismatchError";

  constructor(
    readonly requested: string,
    readonly target: string,
  ) {
    super("The requested capability does not match the target provider");
  }
}

export function createManualOnlyConfirmation(
  signal: AbortSignal,
  prompt: typeof confirm = confirm,
): (redirectUri: string) => Promise<boolean> {
  return (redirectUri) => prompt({ message: redirectUri }, { signal });
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

function allCapabilities(registry: PluginRegistry): readonly OAuthCapabilityReference[] {
  return registry
    .oauthCapabilities()
    .map(({ plugin, capability }) => ({ plugin, capability }))
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

async function choose(
  inputValue: string | undefined,
  registry: PluginRegistry,
  deps: Pick<ProviderLoginDeps, "isTTY" | "selectCapability">,
): Promise<OAuthCapabilityReference> {
  const available = allCapabilities(registry);
  let candidates: readonly OAuthCapabilityReference[];
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
  const selected = await deps.selectCapability(references);
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
    if (
      !isRecord(entry) ||
      entry["kind"] !== "oauth" ||
      Object.hasOwn(entry, "vendor") ||
      typeof entry["plugin"] !== "string" ||
      typeof entry["capability"] !== "string"
    ) {
      throw new AccountCleanupPendingError(providerId);
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

async function createDefaultDeps(): Promise<ProviderLoginDeps> {
  const config = new AtomicConfigFile(configPath());
  const handle = openDb();
  const repository = createPluginRepository(handle.sqlite);
  const diagnostics = createCliPluginDiagnosticFactory();
  const snapshot = await loadPluginRegistry({
    enablements: enablements(await config.read()),
    builtIns: [],
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
    selectCapability: (references) =>
      select({
        message: "OAuth capability",
        choices: references.map((reference) => ({ name: reference, value: reference })),
      }),
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
}

export async function providerLogin(
  capabilityInput: string | undefined,
  options: ProviderLoginOptions,
  injected?: ProviderLoginDeps,
): Promise<void> {
  const deps = injected ?? (await createDefaultDeps());
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
    try {
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
      });
      deps.print(result.providerId);
    } catch (error) {
      if (error instanceof ProviderAccountAlreadyExistsError) deps.print(error.suggestedCommand);
      throw error;
    }
  } finally {
    if (injected === undefined) deps.close?.();
  }
}
