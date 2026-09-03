import type { ProtocolId } from '@aio-proxy/plugin-sdk';
import type { ProviderProtocol } from '@aio-proxy/types';

import { pluginProtocol } from './capabilities';

export { oauthExposedModels } from '@aio-proxy/types';
export { pluginOptionsIdentityDigest } from './identity';
export { materializePluginProvider } from './materialize';
export { createRuntimeFetch, type RuntimeFetchInput } from './runtime-fetch';
export {
  type CatalogJobDescriptor,
  type MaterializePluginProviderOptions,
  PLUGIN_RUNTIME_TIMEOUT_MS,
  type PluginOptionsIdentityDigest,
  type PluginProviderMaterialization,
  PluginRawResolverError,
  PluginRawTransportError,
  type PluginRuntimeCacheEntry,
  type RuntimeIdentityKey,
} from './types';

export function validatePluginProtocolMap(): Readonly<Record<ProviderProtocol, ProtocolId>> {
  return pluginProtocol;
}
