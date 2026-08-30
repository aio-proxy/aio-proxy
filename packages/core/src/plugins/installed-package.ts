import { pathToFileURL } from 'node:url';

import { isPluginDescriptor, type PluginDescriptor } from '@aio-proxy/plugin-sdk';
import { type Diagnostic } from '@aio-proxy/types';

import type { NpmPackageInfo } from '../npm';
import { isAiSdkProviderModule } from '../provider/ai-sdk-loader/index';
import { validateConfigSpec } from './config-spec';
import type { DiagnosticFactory, PluginLogSink } from './diagnostic/index';
import { observedPromiseDeadline, PLUGIN_IMPORT_TIMEOUT_MS, validateDescriptor } from './loader/descriptor/index';
import type { PluginPackageImporter } from './loader/index';
import { loadPluginRegistry } from './loader/index';

export class InstalledPackageInvalidError extends Error {
  override readonly name = 'InstalledPackageInvalidError';

  constructor(readonly packageName: string) {
    super(`Installed package is not a valid plugin or AI SDK provider: ${packageName}`);
  }
}

export type InstalledPackageClassification =
  | { readonly kind: 'plugin'; readonly descriptor: PluginDescriptor<unknown> }
  | { readonly kind: 'ai-sdk-provider' };

export class PluginSetupInvalidError extends Error {
  override readonly name = 'PluginSetupInvalidError';

  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.summary);
  }
}

export async function classifyInstalledPackage(
  packageName: string,
  installed: NpmPackageInfo,
  importPackage: PluginPackageImporter,
  importTimeoutMs = PLUGIN_IMPORT_TIMEOUT_MS,
): Promise<InstalledPackageClassification> {
  const attempt = crypto.randomUUID();
  const entrypoint = pathToFileURL(installed.entrypoint);
  entrypoint.searchParams.set('aio_proxy_package_attempt', attempt);
  const imported = await observedPromiseDeadline(
    importPackage({ packageName, version: installed.version, entrypoint: entrypoint.href, attempt }),
    {
      timeoutMs: importTimeoutMs,
      timeoutError: () => new InstalledPackageInvalidError(packageName),
    },
  );
  if (imported !== null && typeof imported === 'object' && isPluginDescriptor(Reflect.get(imported, 'default'))) {
    try {
      const descriptor = validateDescriptor(Reflect.get(imported, 'default'));
      if (descriptor.metadata.options !== undefined) validateConfigSpec(descriptor.metadata.options);
      return { kind: 'plugin', descriptor };
    } catch {
      throw new InstalledPackageInvalidError(packageName);
    }
  }
  if (isAiSdkProviderModule(imported)) return { kind: 'ai-sdk-provider' };
  throw new InstalledPackageInvalidError(packageName);
}

export async function stagePluginDescriptor(options: {
  readonly packageName: string;
  readonly version: string;
  readonly descriptor: PluginDescriptor<unknown>;
  readonly publicValues: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, unknown>>;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
}): Promise<void> {
  const snapshot = await loadPluginRegistry({
    enablements: [
      {
        packageName: options.packageName,
        ...(Object.keys(options.publicValues).length === 0 ? {} : { options: options.publicValues }),
      },
    ],
    builtIns: [{ packageName: options.packageName, version: options.version, descriptor: options.descriptor }],
    diagnostics: options.diagnostics,
    importPackage: async () => ({ default: options.descriptor }),
    logger: options.logger,
    secrets: { readPluginSecret: () => options.secrets },
  });
  const state = snapshot.plugins.get(options.packageName)?.state;
  if (state?.status === 'failed') throw new PluginSetupInvalidError(state.diagnostic);
}
