import {
  AtomicConfigFile,
  BUILT_IN_PLUGIN_PACKAGE_NAMES,
  type BuiltInPluginDefinition,
  configPath,
  createEmbeddedBuiltIns,
  createPluginDiagnosticFactory,
  createPluginRepository,
  type DiagnosticFactory,
  findInstalledNpmPackage,
  type InstalledNpmPackage,
  listInstalledNpmPackages,
  type NpmPackageInfo,
  npmAdd,
  type PluginPackageImporter,
  type PluginRepository,
  removeNpmPackageCache,
  withInstalledNpmPackage,
  withNpmPackageLifecycle,
} from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { confirm, input, password, select } from "@inquirer/prompts";
import type { PluginFormPrompts } from "../form";
import { PluginConfirmationRequiredError, PluginTrustRejectedError } from "./errors";

export type SecretRepository = Pick<PluginRepository, "readPluginSecret" | "writePluginSecret" | "deletePluginSecret">;

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
  readonly importTimeoutMs?: number;
  readonly listInstalledNpmPackages: () => Promise<readonly InstalledNpmPackage[]>;
  readonly removeNpmPackageCache: (packageName: string, canRemove?: () => Promise<boolean>) => Promise<boolean>;
  readonly print: (line: string) => void;
  readonly close?: () => void;
};

export function createCliPluginDiagnosticFactory(): DiagnosticFactory {
  return createPluginDiagnosticFactory();
}

export function createPluginConfirmation(
  prompt: typeof confirm = confirm,
): (message: string, signal?: AbortSignal) => Promise<boolean> {
  return (message, signal) => prompt({ message, default: false }, signal === undefined ? undefined : { signal });
}

export async function requireConfirmation(
  message: string,
  options: { readonly yes?: boolean },
  deps: PluginLifecycleDeps,
  packageName?: string,
): Promise<void> {
  if (options.yes === true) return;
  if (!deps.isTTY) throw new PluginConfirmationRequiredError(packageName);
  if (!(await deps.confirm(message))) throw new PluginTrustRejectedError();
}

export function createDefaultPluginLifecycleDeps(): PluginLifecycleDeps {
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
    builtIns: createEmbeddedBuiltIns(),
    isTTY: process.stdin.isTTY === true,
    prompts: { input, password, confirm, select },
    confirm: createPluginConfirmation(),
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
