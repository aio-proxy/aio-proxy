import type { LocalizedText, PluginDescriptor } from "@aio-proxy/plugin-sdk";
import type { PluginEnablement, PluginState } from "@aio-proxy/types";
import { findInstalledNpmPackage } from "../../npm";
import { collectSecretStrings, type DiagnosticFactory, type PluginLogSink } from "../diagnostic";
import { createPluginRegistryHost, type PluginRegistry } from "../registry";
import { candidates, failedState, prepareOptions } from "./candidates";
import {
  loadThirdPartyDescriptor,
  observedPromiseDeadline,
  PLUGIN_SETUP_TIMEOUT_MS,
  PluginHostError,
  validateDescriptor,
} from "./descriptor";

export type { ObservedPromiseDeadlineOptions } from "./descriptor";
export { observedPromiseDeadline, PLUGIN_IMPORT_TIMEOUT_MS, PLUGIN_SETUP_TIMEOUT_MS } from "./descriptor";

export type BuiltInPluginDefinition = {
  readonly packageName: string;
  readonly version: string;
  readonly descriptor: PluginDescriptor<unknown>;
};
export type PluginPackageImporter = (input: {
  readonly packageName: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly attempt: string;
}) => Promise<unknown>;
export type LoadedPluginState = {
  readonly packageName: string;
  readonly label?: LocalizedText;
  readonly description?: LocalizedText;
  readonly version?: string;
  readonly builtIn: boolean;
  readonly state: PluginState;
};
export type PluginRegistrySnapshot = {
  readonly registry: PluginRegistry;
  readonly plugins: ReadonlyMap<string, LoadedPluginState>;
};
export type PluginSecretReader = { readonly readPluginSecret: (plugin: string) => unknown | undefined };
export type LoadPluginRegistryOptions = {
  readonly enablements: readonly PluginEnablement[];
  readonly builtIns: readonly BuiltInPluginDefinition[];
  readonly diagnostics: DiagnosticFactory;
  readonly importPackage: PluginPackageImporter;
  readonly logger: PluginLogSink;
  readonly secrets: PluginSecretReader;
};

export async function loadPluginRegistry(options: LoadPluginRegistryOptions): Promise<PluginRegistrySnapshot> {
  const host = createPluginRegistryHost(options.logger);
  const plugins = new Map<string, LoadedPluginState>();
  for (const candidate of candidates(options)) {
    let secretValues: readonly string[] = [];
    let version: string | undefined;
    let label: LocalizedText | undefined;
    let description: LocalizedText | undefined;
    try {
      const secretOptions = options.secrets.readPluginSecret(candidate.packageName);
      secretValues = collectSecretStrings(secretOptions);
      let descriptor: PluginDescriptor<unknown>;
      if (candidate.builtIn === undefined) {
        const installed = await findInstalledNpmPackage(candidate.packageName);
        if (installed === null) throw new PluginHostError("PLUGIN_NOT_INSTALLED");
        version = installed.version;
        descriptor = await loadThirdPartyDescriptor(candidate.packageName, installed, options.importPackage);
      } else {
        version = candidate.builtIn.version;
        descriptor = validateDescriptor(candidate.builtIn.descriptor);
      }
      label = descriptor.metadata.label;
      description = descriptor.metadata.description;
      const staging = host.stage(candidate.packageName);
      const setup = Promise.resolve().then(async () => {
        const pluginOptions = await prepareOptions(descriptor, candidate.options, secretOptions);
        return descriptor.setup(staging.api, pluginOptions);
      });
      try {
        await observedPromiseDeadline(setup, {
          timeoutMs: PLUGIN_SETUP_TIMEOUT_MS,
          timeoutError: () => new PluginHostError("PLUGIN_LOAD_FAILED", true),
          onTimeout: staging.seal,
        });
      } catch (error) {
        staging.seal();
        throw error;
      }
      staging.seal();
      staging.commit();
      plugins.set(candidate.packageName, {
        packageName: candidate.packageName,
        ...(label === undefined ? {} : { label }),
        ...(description === undefined ? {} : { description }),
        ...(version === undefined ? {} : { version }),
        builtIn: candidate.builtIn !== undefined,
        state: { status: "ready" },
      });
    } catch (error) {
      plugins.set(candidate.packageName, {
        packageName: candidate.packageName,
        ...(label === undefined ? {} : { label }),
        ...(description === undefined ? {} : { description }),
        ...(version === undefined ? {} : { version }),
        builtIn: candidate.builtIn !== undefined,
        state: failedState(options, candidate.packageName, error, secretValues, candidate.configured),
      });
    }
  }
  return { registry: host.registry, plugins };
}
