import type { LocalizedText, PluginDescriptor, PluginIcon } from '@aio-proxy/plugin-sdk';
import type { PluginEnablement, PluginState } from '@aio-proxy/types';

import { findInstalledNpmPackage } from '../../npm';
import { collectSecretStrings, type DiagnosticFactory, type PluginLogSink } from '../diagnostic/index';
import { createPluginRegistryHost, type PluginLoggerFactory, type PluginRegistry } from '../registry';
import { candidates, failedState, prepareOptions } from './candidates';
import {
  loadThirdPartyDescriptor,
  type LoadablePluginDescriptor,
  observedPromiseDeadline,
  PLUGIN_SETUP_TIMEOUT_MS,
  PluginHostError,
  validateDescriptor,
} from './descriptor/index';

export type { ObservedPromiseDeadlineOptions } from './descriptor/index';
export { observedPromiseDeadline, PLUGIN_IMPORT_TIMEOUT_MS, PLUGIN_SETUP_TIMEOUT_MS } from './descriptor/index';

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
  readonly displayName?: LocalizedText;
  readonly description?: LocalizedText;
  readonly icon?: PluginIcon;
  readonly version?: string;
  readonly builtIn: boolean;
  readonly hasOptions?: boolean;
  readonly state: PluginState;
};
export type PluginRegistrySnapshot = {
  readonly registry: PluginRegistry;
  readonly plugins: ReadonlyMap<string, LoadedPluginState>;
};
export type PluginSecretReader = { readonly readPluginSecret: (plugin: string) => unknown };
export type LoadPluginRegistryOptions = {
  readonly enablements: readonly PluginEnablement[];
  readonly builtIns: readonly BuiltInPluginDefinition[];
  readonly diagnostics: DiagnosticFactory;
  readonly importPackage: PluginPackageImporter;
  readonly logger: PluginLogSink;
  readonly createPluginLogger?: PluginLoggerFactory;
  readonly secrets: PluginSecretReader;
};

export async function loadPluginRegistry(options: LoadPluginRegistryOptions): Promise<PluginRegistrySnapshot> {
  const host = createPluginRegistryHost(options.createPluginLogger);
  const plugins = new Map<string, LoadedPluginState>();
  for (const candidate of candidates(options)) {
    let secretValues: readonly string[] = [];
    let version: string | undefined;
    let displayName: LocalizedText | undefined;
    let description: LocalizedText | undefined;
    let icon: PluginIcon | undefined;
    let hasOptions = false;
    try {
      const secretOptions = options.secrets.readPluginSecret(candidate.packageName);
      secretValues = collectSecretStrings(secretOptions);
      let descriptor: LoadablePluginDescriptor<unknown>;
      if (candidate.builtIn === undefined) {
        const installed = await findInstalledNpmPackage(candidate.packageName);
        if (installed === null) throw new PluginHostError('PLUGIN_NOT_INSTALLED');
        version = installed.version;
        descriptor = await loadThirdPartyDescriptor(
          candidate.packageName,
          installed,
          options.importPackage,
          options.logger,
        );
      } else {
        version = candidate.builtIn.version;
        descriptor = validateDescriptor(candidate.builtIn.descriptor, {
          packageName: candidate.packageName,
          logger: options.logger,
        });
      }
      displayName = descriptor.metadata.displayName;
      description = descriptor.metadata.description;
      icon = descriptor.metadata.icon;
      hasOptions = descriptor.metadata.options !== undefined;
      const staging = host.stage(candidate.packageName, { redactSecretValues: secretValues });
      const setup = Promise.resolve().then(async () => {
        const pluginOptions = await prepareOptions(descriptor, candidate.options, secretOptions);
        return descriptor.setup(staging.api, pluginOptions);
      });
      try {
        await observedPromiseDeadline(setup, {
          timeoutMs: PLUGIN_SETUP_TIMEOUT_MS,
          timeoutError: () => new PluginHostError('PLUGIN_LOAD_FAILED', true),
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
        ...(displayName === undefined ? {} : { displayName }),
        ...(description === undefined ? {} : { description }),
        ...(icon === undefined ? {} : { icon }),
        ...(version === undefined ? {} : { version }),
        builtIn: candidate.builtIn !== undefined,
        hasOptions,
        state: { status: 'ready' },
      });
    } catch (error) {
      plugins.set(candidate.packageName, {
        packageName: candidate.packageName,
        ...(displayName === undefined ? {} : { displayName }),
        ...(description === undefined ? {} : { description }),
        ...(icon === undefined ? {} : { icon }),
        ...(version === undefined ? {} : { version }),
        builtIn: candidate.builtIn !== undefined,
        hasOptions,
        state: failedState(options, candidate.packageName, error, secretValues, candidate.configured),
      });
    }
  }
  return { registry: host.registry, plugins };
}
