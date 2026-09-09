import type { PluginDescriptor } from '../packages/plugin-sdk/src';

const backendPlugins: Readonly<Record<string, { readonly entry: string }>> = {
  '@aio-proxy/plugin-cloudkit': { entry: 'cloudkit/src/index.ts' },
};

export class BackendSetupError extends Error {
  constructor(readonly code: 'setup-backend-required' | 'setup-backend-unavailable') {
    super(code);
  }
}

export async function loadSyncBackendDescriptor(plugin: string): Promise<PluginDescriptor> {
  const moduleName = process.env['OAUTH_SYNC_BACKEND_MODULE']?.trim();
  const spec = backendPlugins[plugin];
  if (moduleName === undefined && spec === undefined) throw new BackendSetupError('setup-backend-required');
  const source = moduleName ?? new URL(`../packages/plugins/${spec!.entry}`, import.meta.url).href;
  const imported = (await import(source)) as {
    readonly default?: PluginDescriptor;
  };
  if (imported.default === undefined) throw new BackendSetupError('setup-backend-unavailable');
  return imported.default;
}
