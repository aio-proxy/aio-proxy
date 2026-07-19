import type { AuthorizationPort } from "@aio-proxy/plugin-sdk";

import {
  AtomicConfigFile,
  configPath,
  createEmbeddedBuiltIns,
  createPluginRepository,
  type DiagnosticFactory,
  type LoginOAuthAccountOptions,
  type LoginOAuthAccountResult,
  loadPluginRegistry,
  type PluginLogSink,
  type PluginRegistry,
  type PluginRepository,
  type recoverPendingAccountOperations,
} from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { confirm, input, password, select } from "@inquirer/prompts";

import { openBrowser } from "../../open-browser";
import { createCliAuthorizationPort, createDefaultCliAuthorizationCopy } from "../authorization";
import { type PluginFormPrompts, renderConfigSpec } from "../form";
import { createCliPluginDiagnosticFactory } from "../plugin";
import { type CapabilityChoice, createCapabilitySelector, createManualOnlyConfirmation } from "./capability";

type ConfigRecord = Record<string, unknown>;

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

export type ProviderLoginDefaultDepsOptions = {
  readonly config?: AtomicConfigFile;
  readonly openDatabase?: typeof openDb;
  readonly createRepository?: typeof createPluginRepository;
  readonly loadRegistry?: typeof loadPluginRegistry;
};

function enablements(config: ConfigRecord): readonly { readonly packageName: string; readonly options?: unknown }[] {
  if (!Array.isArray(config.plugins)) return [];
  return config.plugins.flatMap((entry) => {
    if (typeof entry === "string") return [{ packageName: entry }];
    if (Array.isArray(entry) && typeof entry[0] === "string") {
      return [{ packageName: entry[0], ...(entry.length < 2 ? {} : { options: entry[1] }) }];
    }
    return [];
  });
}

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
