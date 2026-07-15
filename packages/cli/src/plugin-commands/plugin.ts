import { pathToFileURL } from "node:url";
import {
  AtomicConfigCommitUncertainError,
  AtomicConfigFile,
  BUILT_IN_PLUGIN_PACKAGE_NAMES,
  type BuiltInPluginDefinition,
  ConfigSpecValidationError,
  configPath,
  createPluginRepository,
  findInstalledNpmPackage,
  type InstalledNpmPackage,
  isNpmPackageName,
  listInstalledNpmPackages,
  loadPluginRegistry,
  type NpmPackageInfo,
  npmAdd,
  type PluginPackageImporter,
  type PluginRepository,
  type PluginSecretSnapshot,
  removeNpmPackageCache,
  validateConfigSpec,
  withInstalledNpmPackage,
  withNpmPackageLifecycle,
} from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { m } from "@aio-proxy/i18n";
import { isPluginDescriptor, type PluginDescriptor } from "@aio-proxy/plugin-sdk";
import { type Diagnostic, type DiagnosticCode, PluginPackageNameSchema } from "@aio-proxy/types";
import { confirm, input, password, select } from "@inquirer/prompts";
import type { PluginFormPrompts } from "./form";
import { renderConfigSpec } from "./form";

type ConfigRecord = Record<string, unknown>;
type SecretRepository = Pick<PluginRepository, "readPluginSecret" | "writePluginSecret" | "deletePluginSecret">;

export type PluginAddOptions = { readonly yes?: boolean; readonly registry?: string };
export type PluginConfigOptions = { readonly clearSecret?: readonly string[] };
export type PluginRemoveOptions = { readonly purgeSecrets?: boolean; readonly yes?: boolean };
export type PluginPruneOptions = { readonly yes?: boolean };
export type PluginListOptions = Record<string, never>;

export type PluginLifecycleDeps = {
  readonly config: AtomicConfigFile;
  readonly repository: SecretRepository;
  readonly builtInNames: ReadonlySet<string>;
  readonly builtIns?: readonly BuiltInPluginDefinition[];
  readonly isTTY: boolean;
  readonly prompts: PluginFormPrompts;
  readonly confirm: (message: string, signal?: AbortSignal) => Promise<boolean>;
  readonly npmAdd: (packageName: string, registry?: string) => Promise<NpmPackageInfo>;
  readonly withInstalledNpmPackage?: <T>(
    packageName: string,
    registry: string | undefined,
    use: (installed: NpmPackageInfo, assertOwnership: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  readonly withNpmPackageLifecycle?: <T>(
    packageName: string,
    use: (assertOwnership: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  readonly findInstalledNpmPackage?: (packageName: string) => Promise<NpmPackageInfo | null>;
  readonly importPackage: PluginPackageImporter;
  readonly listInstalledNpmPackages: () => Promise<readonly InstalledNpmPackage[]>;
  readonly removeNpmPackageCache: (packageName: string, canRemove?: () => Promise<boolean>) => Promise<boolean>;
  readonly print: (line: string) => void;
  readonly close?: () => void;
};

export class PluginConfirmationRequiredError extends Error {
  override readonly name = "PluginConfirmationRequiredError";
  constructor(readonly packageName?: string) {
    super(
      packageName === undefined
        ? m.cli_plugin_error_confirmation_required()
        : m.cli_plugin_error_confirmation_required_for({ plugin: packageName }),
    );
  }
}

export class PluginTrustRejectedError extends Error {
  override readonly name = "PluginTrustRejectedError";
  constructor() {
    super(m.cli_plugin_error_cancelled());
  }
}

export class PluginDescriptorInvalidError extends Error {
  override readonly name = "PluginDescriptorInvalidError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_descriptor_invalid({ plugin: packageName }));
  }
}

export class PluginNotConfiguredError extends Error {
  override readonly name = "PluginNotConfiguredError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_not_configured({ plugin: packageName }));
  }
}

export class PluginNotInstalledError extends Error {
  override readonly name = "PluginNotInstalledError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_not_installed({ plugin: packageName }));
  }
}

export class PluginConfigChangedError extends Error {
  override readonly name = "PluginConfigChangedError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_config_changed({ plugin: packageName }));
  }
}

export class BuiltInPluginRemovalError extends Error {
  override readonly name = "BuiltInPluginRemovalError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_builtin_remove({ plugin: packageName }));
  }
}

export class PluginSecretPurgeConflictError extends Error {
  override readonly name = "PluginSecretPurgeConflictError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_purge_conflict({ plugin: packageName }));
  }
}

export class PluginSetupValidationError extends Error {
  override readonly name = "PluginSetupValidationError";
  constructor(
    readonly packageName: string,
    summary: string,
  ) {
    super(summary);
  }
}

export const pluginErrors = [
  PluginConfirmationRequiredError,
  PluginTrustRejectedError,
  PluginDescriptorInvalidError,
  PluginNotConfiguredError,
  PluginNotInstalledError,
  PluginConfigChangedError,
  BuiltInPluginRemovalError,
  PluginSecretPurgeConflictError,
  PluginSetupValidationError,
] as const;

function diagnosticSummary(
  code: DiagnosticCode,
  context: { plugin?: string; capability?: string; providerId?: string },
): string {
  const pluginResult = PluginPackageNameSchema.safeParse(context.plugin);
  const plugin = pluginResult.success ? pluginResult.data : "<plugin>";
  const capability = /^[a-z0-9][a-z0-9._-]*$/u.test(context.capability ?? "")
    ? (context.capability as string)
    : "<capability>";
  const provider = /^[a-z0-9][a-z0-9._~-]*$/iu.test(context.providerId ?? "")
    ? (context.providerId as string)
    : "<provider>";
  switch (code) {
    case "PLUGIN_NOT_INSTALLED":
      return m.cli_plugin_diagnostic_plugin_not_installed({ plugin });
    case "PLUGIN_API_INCOMPATIBLE":
      return m.cli_plugin_diagnostic_plugin_api_incompatible({ plugin });
    case "PLUGIN_LOAD_FAILED":
      return m.cli_plugin_diagnostic_plugin_load_failed({ plugin });
    case "PLUGIN_OPTIONS_INVALID":
      return m.cli_plugin_diagnostic_plugin_options_invalid({ plugin });
    case "PROVIDER_CONFIG_INVALID":
      return m.cli_plugin_diagnostic_provider_config_invalid({ provider });
    case "LEGACY_OAUTH_CONFIG_UNSUPPORTED":
      return m.cli_plugin_diagnostic_legacy_oauth_config_unsupported({ provider });
    case "CAPABILITY_MISSING":
      return m.cli_plugin_diagnostic_capability_missing({ plugin, capability });
    case "ACCOUNT_OPTIONS_INVALID":
      return m.cli_plugin_diagnostic_account_options_invalid({ provider });
    case "CREDENTIALS_MISSING_OR_INVALID":
      return m.cli_plugin_diagnostic_credentials_missing_or_invalid({ provider });
    case "CREDENTIAL_REFRESH_FAILED":
      return m.cli_plugin_diagnostic_credential_refresh_failed({ provider });
    case "AUTHORIZATION_FAILED":
      return m.cli_plugin_diagnostic_authorization_failed({ provider });
    case "CATALOG_UNAVAILABLE":
      return m.cli_plugin_diagnostic_catalog_unavailable({ provider });
    case "RUNTIME_CREATE_FAILED":
      return m.cli_plugin_diagnostic_runtime_create_failed({ provider });
  }
}

export function createCliPluginDiagnosticFactory(): (
  code: DiagnosticCode,
  options: {
    readonly plugin?: string;
    readonly capability?: string;
    readonly providerId?: string;
    readonly retryable: boolean;
    readonly suggestedCommand?: string;
  },
) => Diagnostic {
  return (code, options) => ({
    code,
    summary: diagnosticSummary(code, options),
    retryable: options.retryable,
    occurredAt: new Date().toISOString(),
    ...(options.suggestedCommand === undefined ? {} : { suggestedCommand: options.suggestedCommand }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entries(config: ConfigRecord): unknown[] {
  return Array.isArray(config["plugins"]) ? config["plugins"] : [];
}

function packageNameOf(entry: unknown): string | null {
  const candidate = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : undefined;
  const parsed = PluginPackageNameSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function requirePluginPackageName(value: string): string {
  return PluginPackageNameSchema.parse(value);
}

function publicOptionsOf(entry: unknown): Record<string, unknown> {
  return Array.isArray(entry) && isRecord(entry[1]) ? entry[1] : {};
}

function pluginEntry(packageName: string, publicValues: Record<string, unknown>): unknown {
  return Object.keys(publicValues).length === 0 ? packageName : [packageName, publicValues];
}

function replacePlugin(config: ConfigRecord, packageName: string, entry: unknown): ConfigRecord {
  const current = entries(config);
  const found = current.findIndex((candidate) => packageNameOf(candidate) === packageName);
  return {
    ...config,
    plugins: found < 0 ? [...current, entry] : current.map((candidate, index) => (index === found ? entry : candidate)),
  };
}

function removePlugin(config: ConfigRecord, packageName: string): ConfigRecord {
  return { ...config, plugins: entries(config).filter((entry) => packageNameOf(entry) !== packageName) };
}

function secretRecord(snapshot: PluginSecretSnapshot | null): Record<string, unknown> {
  return isRecord(snapshot?.value) ? snapshot.value : {};
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function requireConfirmation(
  message: string,
  options: { readonly yes?: boolean },
  deps: PluginLifecycleDeps,
  packageName?: string,
): Promise<void> {
  if (options.yes === true) return;
  if (!deps.isTTY) throw new PluginConfirmationRequiredError(packageName);
  if (!(await deps.confirm(message))) throw new PluginTrustRejectedError();
}

function descriptorFromModule(packageName: string, imported: unknown): PluginDescriptor<unknown> {
  if (!isRecord(imported)) throw new PluginDescriptorInvalidError(packageName);
  const descriptor = imported["default"];
  if (!isPluginDescriptor(descriptor)) throw new PluginDescriptorInvalidError(packageName);
  const typed = descriptor as PluginDescriptor<unknown>;
  try {
    if (typed.metadata.options !== undefined) validateConfigSpec(typed.metadata.options);
  } catch (error) {
    if (error instanceof ConfigSpecValidationError) throw new PluginDescriptorInvalidError(packageName);
    throw error;
  }
  return typed;
}

async function loadDescriptor(
  packageName: string,
  installed: NpmPackageInfo,
  deps: PluginLifecycleDeps,
): Promise<PluginDescriptor<unknown>> {
  const attempt = crypto.randomUUID();
  const entrypoint = pathToFileURL(installed.entrypoint);
  entrypoint.searchParams.set("aio_proxy_cli_attempt", attempt);
  return descriptorFromModule(
    packageName,
    await deps.importPackage({ packageName, version: installed.version, entrypoint: entrypoint.href, attempt }),
  );
}

async function stageDescriptor(
  packageName: string,
  version: string,
  descriptor: PluginDescriptor<unknown>,
  publicValues: Record<string, unknown>,
  secrets: Record<string, unknown>,
): Promise<void> {
  const snapshot = await loadPluginRegistry({
    enablements: [{ packageName, ...(Object.keys(publicValues).length === 0 ? {} : { options: publicValues }) }],
    builtIns: [{ packageName, version, descriptor }],
    diagnostics: createCliPluginDiagnosticFactory(),
    importPackage: async () => ({ default: descriptor }),
    logger: () => {},
    secrets: { readPluginSecret: () => secrets },
  });
  const state = snapshot.plugins.get(packageName)?.state;
  if (state?.status === "failed") throw new PluginSetupValidationError(packageName, state.diagnostic.summary);
}

async function compensateSecret(
  packageName: string,
  previous: PluginSecretSnapshot | null,
  appliedRevision: number | null,
  repository: SecretRepository,
): Promise<void> {
  if (appliedRevision === null) return;
  if (previous === null) {
    repository.deletePluginSecret(packageName, appliedRevision);
    return;
  }
  try {
    repository.writePluginSecret(packageName, appliedRevision, previous.value);
  } catch (error) {
    if (repository.readPluginSecret(packageName)?.revision !== appliedRevision) return;
    throw error;
  }
}

async function commitPluginConfig(
  packageName: string,
  publicValues: Record<string, unknown>,
  secrets: Record<string, unknown>,
  previousSecret: PluginSecretSnapshot | null,
  deps: PluginLifecycleDeps,
  options: {
    readonly expectedEntry?: unknown;
    readonly assertPackageOwnership?: () => Promise<void>;
  } = {},
): Promise<void> {
  let appliedRevision: number | null = null;
  try {
    await deps.config.transaction(async (current) => {
      if (Object.hasOwn(options, "expectedEntry")) {
        const latest = entries(current).find((entry) => packageNameOf(entry) === packageName);
        if (latest === undefined) throw new PluginNotConfiguredError(packageName);
        if (!sameJson(latest, options.expectedEntry)) throw new PluginConfigChangedError(packageName);
      }
      const latestSecret = deps.repository.readPluginSecret(packageName);
      if (
        (latestSecret?.revision ?? null) !== (previousSecret?.revision ?? null) ||
        !sameJson(latestSecret?.value, previousSecret?.value)
      ) {
        throw new PluginConfigChangedError(packageName);
      }
      await options.assertPackageOwnership?.();
      if (
        (previousSecret === null && Object.keys(secrets).length > 0) ||
        (previousSecret !== null && !sameJson(previousSecret.value, secrets))
      ) {
        appliedRevision = deps.repository.writePluginSecret(
          packageName,
          previousSecret?.revision ?? null,
          secrets,
        ).revision;
      }
      return {
        next: replacePlugin(current, packageName, pluginEntry(packageName, publicValues)),
        result: undefined,
      };
    });
  } catch (error) {
    if (!(error instanceof AtomicConfigCommitUncertainError)) {
      await compensateSecret(packageName, previousSecret, appliedRevision, deps.repository);
    }
    throw error;
  }
}

async function installedForConfig(packageName: string, deps: PluginLifecycleDeps): Promise<NpmPackageInfo> {
  const installed = await (deps.findInstalledNpmPackage ?? findInstalledNpmPackage)(packageName);
  if (installed === null) throw new PluginNotInstalledError(packageName);
  return installed;
}

async function descriptorForConfig(
  packageName: string,
  deps: PluginLifecycleDeps,
): Promise<{ readonly descriptor: PluginDescriptor<unknown>; readonly version: string }> {
  const builtIn = deps.builtIns?.find((definition) => definition.packageName === packageName);
  if (builtIn !== undefined) return { descriptor: builtIn.descriptor, version: builtIn.version };
  const installed = await installedForConfig(packageName, deps);
  return { descriptor: await loadDescriptor(packageName, installed, deps), version: installed.version };
}

function createDefaultDeps(): PluginLifecycleDeps {
  let handle: ReturnType<typeof openDb> | undefined;
  let repository: PluginRepository | undefined;
  const getRepository = (): PluginRepository => {
    if (repository !== undefined) return repository;
    handle = openDb();
    repository = createPluginRepository(handle.sqlite);
    return repository;
  };
  return {
    config: new AtomicConfigFile(configPath()),
    repository: {
      readPluginSecret: (plugin) => getRepository().readPluginSecret(plugin),
      writePluginSecret: (plugin, expectedRevision, value) =>
        getRepository().writePluginSecret(plugin, expectedRevision, value),
      deletePluginSecret: (plugin, expectedRevision) => getRepository().deletePluginSecret(plugin, expectedRevision),
    },
    builtInNames: new Set(BUILT_IN_PLUGIN_PACKAGE_NAMES),
    builtIns: [],
    isTTY: process.stdin.isTTY === true,
    prompts: { input, password, confirm, select },
    confirm: (message, signal) => confirm({ message }, signal === undefined ? undefined : { signal }),
    npmAdd,
    withInstalledNpmPackage,
    withNpmPackageLifecycle,
    findInstalledNpmPackage,
    importPackage: async ({ entrypoint }) => import(entrypoint),
    listInstalledNpmPackages,
    removeNpmPackageCache,
    print: console.log,
    close: () => handle?.close(),
  };
}

export async function pluginAdd(
  packageName: string,
  options: PluginAddOptions,
  injected?: PluginLifecycleDeps,
): Promise<void> {
  const deps = injected ?? createDefaultDeps();
  try {
    packageName = requirePluginPackageName(packageName);
    if (deps.builtInNames.has(packageName)) {
      deps.print(m.cli_plugin_already_builtin({ plugin: packageName }));
      return;
    }
    await requireConfirmation(m.cli_plugin_trust_prompt({ plugin: packageName }), options, deps, packageName);
    const installAndUse =
      deps.withInstalledNpmPackage ??
      (async (name, registry, use) => use(await deps.npmAdd(name, registry), async () => {}));
    await installAndUse(packageName, options.registry, async (installed, assertOwnership = async () => {}) => {
      const descriptor = await loadDescriptor(packageName, installed, deps);
      const rendered =
        descriptor.metadata.options === undefined
          ? { publicValues: {}, secrets: {} }
          : await renderConfigSpec(descriptor.metadata.options, { prompts: deps.prompts });
      await stageDescriptor(packageName, installed.version, descriptor, rendered.publicValues, rendered.secrets);
      const previousSecret = deps.repository.readPluginSecret(packageName);
      await commitPluginConfig(packageName, rendered.publicValues, rendered.secrets, previousSecret, deps, {
        assertPackageOwnership: assertOwnership,
      });
    });
    deps.print(m.cli_plugin_added({ plugin: packageName }));
  } finally {
    if (injected === undefined) deps.close?.();
  }
}

export async function pluginConfig(
  packageName: string,
  options: PluginConfigOptions,
  injected?: PluginLifecycleDeps,
): Promise<void> {
  const deps = injected ?? createDefaultDeps();
  try {
    packageName = requirePluginPackageName(packageName);
    const current = await deps.config.read();
    const currentEntry = entries(current).find((entry) => packageNameOf(entry) === packageName);
    if (currentEntry === undefined) throw new PluginNotConfiguredError(packageName);
    const configure = async (
      descriptor: PluginDescriptor<unknown>,
      version: string,
      assertPackageOwnership?: () => Promise<void>,
    ) => {
      const previousSecret = deps.repository.readPluginSecret(packageName);
      const rendered =
        descriptor.metadata.options === undefined
          ? { publicValues: {}, secrets: {} }
          : await renderConfigSpec(descriptor.metadata.options, {
              prompts: deps.prompts,
              currentPublicValues: publicOptionsOf(currentEntry),
              currentSecrets: secretRecord(previousSecret),
              ...(options.clearSecret === undefined ? {} : { clearSecrets: options.clearSecret }),
            });
      await stageDescriptor(packageName, version, descriptor, rendered.publicValues, rendered.secrets);
      await assertPackageOwnership?.();
      await commitPluginConfig(packageName, rendered.publicValues, rendered.secrets, previousSecret, deps, {
        expectedEntry: currentEntry,
        ...(assertPackageOwnership === undefined ? {} : { assertPackageOwnership }),
      });
    };
    if (deps.builtInNames.has(packageName)) {
      const { descriptor, version } = await descriptorForConfig(packageName, deps);
      await configure(descriptor, version);
    } else {
      const lifecycle = deps.withNpmPackageLifecycle ?? (async (_packageName, use) => use(async () => {}));
      await lifecycle(packageName, async (assertOwnership) => {
        await assertOwnership();
        const installed = await installedForConfig(packageName, deps);
        await assertOwnership();
        const descriptor = await loadDescriptor(packageName, installed, deps);
        await assertOwnership();
        await configure(descriptor, installed.version, assertOwnership);
      });
    }
    deps.print(m.cli_plugin_configured({ plugin: packageName }));
  } finally {
    if (injected === undefined) deps.close?.();
  }
}

export async function pluginList(_options: PluginListOptions, injected?: PluginLifecycleDeps): Promise<void> {
  const deps = injected ?? createDefaultDeps();
  try {
    const config = await deps.config.read();
    const enablements = entries(config).flatMap((entry) => {
      const packageName = packageNameOf(entry);
      return packageName === null ? [] : [{ packageName, ...(Array.isArray(entry) ? { options: entry[1] } : {}) }];
    });
    const configured = new Set(enablements.map((entry) => entry.packageName));
    const installed = new Set((await deps.listInstalledNpmPackages()).map((pkg) => pkg.packageName));
    const snapshot = await loadPluginRegistry({
      enablements,
      builtIns: deps.builtIns ?? [],
      diagnostics: createCliPluginDiagnosticFactory(),
      importPackage: deps.importPackage,
      logger: () => {},
      secrets: { readPluginSecret: (plugin) => deps.repository.readPluginSecret(plugin)?.value },
    });
    const names = [...new Set([...deps.builtInNames, ...configured])].sort();
    for (const packageName of names) {
      const loaded = snapshot.plugins.get(packageName);
      const state =
        loaded?.state.status === "failed"
          ? loaded.state.diagnostic.summary
          : deps.builtInNames.has(packageName)
            ? m.cli_plugin_state_builtin()
            : installed.has(packageName)
              ? m.cli_plugin_state_configured()
              : m.cli_plugin_state_not_installed();
      deps.print(`${packageName} ${state}`);
    }
  } finally {
    if (injected === undefined) deps.close?.();
  }
}

export async function pluginRemove(
  packageName: string,
  options: PluginRemoveOptions,
  injected?: PluginLifecycleDeps,
): Promise<void> {
  const deps = injected ?? createDefaultDeps();
  try {
    packageName = requirePluginPackageName(packageName);
    if (deps.builtInNames.has(packageName)) throw new BuiltInPluginRemovalError(packageName);
    await requireConfirmation(m.cli_plugin_remove_prompt({ plugin: packageName }), options, deps, packageName);
    const lifecycle = deps.withNpmPackageLifecycle ?? (async (_packageName, use) => use(async () => {}));
    await lifecycle(packageName, async (assertOwnership) => {
      await assertOwnership();
      await deps.config.replace((current) => removePlugin(current, packageName));
    });
    if (options.purgeSecrets === true) {
      try {
        await requireConfirmation(m.cli_plugin_purge_prompt({ plugin: packageName }), options, deps, packageName);
      } catch (error) {
        if (!(error instanceof PluginTrustRejectedError)) throw error;
        deps.print(m.cli_plugin_removed_secrets_retained({ plugin: packageName }));
        return;
      }
      await lifecycle(packageName, async (assertOwnership) => {
        await assertOwnership();
        await deps.config.transaction(async (current) => {
          if (entries(current).some((entry) => packageNameOf(entry) === packageName)) {
            throw new PluginSecretPurgeConflictError(packageName);
          }
          await assertOwnership();
          const snapshot = deps.repository.readPluginSecret(packageName);
          if (snapshot !== null && !deps.repository.deletePluginSecret(packageName, snapshot.revision)) {
            throw new PluginSecretPurgeConflictError(packageName);
          }
          return { next: current, result: undefined };
        });
      });
    }
    deps.print(
      options.purgeSecrets === true
        ? m.cli_plugin_removed_secrets_purged({ plugin: packageName })
        : m.cli_plugin_removed_secrets_retained({ plugin: packageName }),
    );
  } finally {
    if (injected === undefined) deps.close?.();
  }
}

function usedPackageNames(config: ConfigRecord): Set<string> {
  const builtIns = new Set<string>(BUILT_IN_PLUGIN_PACKAGE_NAMES);
  const used = new Set(
    entries(config)
      .map(packageNameOf)
      .filter((name): name is string => name !== null && !builtIns.has(name)),
  );
  if (isRecord(config["providers"])) {
    for (const provider of Object.values(config["providers"])) {
      if (!isRecord(provider) || provider["kind"] !== "ai-sdk") continue;
      const packageName = typeof provider["packageName"] === "string" ? provider["packageName"] : provider["package"];
      if (isNpmPackageName(packageName)) used.add(packageName);
    }
  }
  return used;
}

export async function pluginPrune(options: PluginPruneOptions, injected?: PluginLifecycleDeps): Promise<void> {
  const deps = injected ?? createDefaultDeps();
  try {
    await requireConfirmation(m.cli_plugin_prune_prompt(), options, deps);
    const used = usedPackageNames(await deps.config.read());
    const unused = (await deps.listInstalledNpmPackages())
      .map((pkg) => pkg.packageName)
      .filter((packageName) => !used.has(packageName));
    let removed = 0;
    for (const packageName of unused) {
      if (
        await deps.removeNpmPackageCache(
          packageName,
          async () => !usedPackageNames(await deps.config.read()).has(packageName),
        )
      ) {
        removed += 1;
      }
    }
    deps.print(m.cli_plugin_pruned({ count: removed }));
  } finally {
    if (injected === undefined) deps.close?.();
  }
}
