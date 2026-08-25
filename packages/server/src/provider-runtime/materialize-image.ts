import {
  createProviderV4ImageInvoke,
  loadAiSdkProvider,
  type ProviderFetch,
  resolveApiKey,
  validateProviderV4,
} from '@aio-proxy/core';
import type { AiSdkProvider, ApiProvider, Provider } from '@aio-proxy/types';
import { apiProviderEndpoints, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import type { ImageTransport, ModelCapabilityIndex, RuntimeProviderInstance } from '../runtime';
import { supportsImage } from './capability-index';

const IMAGE_BRIDGE_PACKAGES = {
  [ProviderProtocol.OpenAIImage]: '@ai-sdk/openai',
  [ProviderProtocol.OpenAICompatible]: '@ai-sdk/openai-compatible',
  [ProviderProtocol.OpenAIResponse]: '@ai-sdk/openai',
} as const;

export function attachImageTransport(
  instance: RuntimeProviderInstance,
  options: { readonly config: Provider; readonly fetch?: ProviderFetch },
): RuntimeProviderInstance {
  if (instance.image !== undefined || !capabilityIndexHasImage(instance.capabilityIndex)) return instance;
  const image = imageTransportFor(options.config, options.fetch);
  return image === undefined ? instance : { ...instance, image };
}

function capabilityIndexHasImage(index: ModelCapabilityIndex): boolean {
  return Object.keys(index).some((modelId) => supportsImage(index, modelId));
}

function imageTransportFor(config: Provider, fetch?: ProviderFetch): ImageTransport | undefined {
  if (config.kind === ProviderKind.Api) return apiImageTransport(config, fetch);
  if (config.kind === ProviderKind.AiSdk) return aiSdkImageTransport(config, fetch);
  return undefined;
}

function apiImageTransport(config: ApiProvider, fetch?: ProviderFetch): ImageTransport | undefined {
  const endpoint = imageBridgeEndpoint(config);
  if (endpoint === undefined) return undefined;
  const packageName = IMAGE_BRIDGE_PACKAGES[endpoint.protocol];
  const apiKey = resolveApiKey(config.apiKey);
  return lazyImageTransport(config.id, () =>
    loadAiSdkProvider(packageName, {
      ...(apiKey === undefined ? {} : { apiKey }),
      baseURL: endpoint.baseURL,
      ...(config.headers === undefined ? {} : { headers: config.headers }),
      ...(packageName === '@ai-sdk/openai-compatible' ? { name: config.id } : {}),
      ...(fetch === undefined ? {} : { fetch }),
    }),
  );
}

function aiSdkImageTransport(config: AiSdkProvider, fetch?: ProviderFetch): ImageTransport | undefined {
  return lazyImageTransport(config.id, () =>
    loadAiSdkProvider(config.packageName, {
      ...config.options,
      ...(fetch === undefined ? {} : { fetch }),
    }),
  );
}

function imageBridgeEndpoint(config: ApiProvider) {
  const endpoints = apiProviderEndpoints(config);
  return (
    endpoints.find((endpoint) => endpoint.protocol === ProviderProtocol.OpenAIImage) ??
    endpoints.find((endpoint) => endpoint.protocol in IMAGE_BRIDGE_PACKAGES)
  );
}

function lazyImageTransport(providerId: string, load: () => Promise<unknown>): ImageTransport {
  let invoke: ImageTransport['invoke'] | undefined;
  return {
    async invoke(request) {
      invoke ??= await loadedImageInvoke(providerId, load);
      return invoke(request);
    },
  };
}

async function loadedImageInvoke(providerId: string, load: () => Promise<unknown>): Promise<ImageTransport['invoke']> {
  const loaded = await load();
  if (!validateProviderV4(loaded) || typeof loaded.imageModel !== 'function') {
    throw new TypeError(`Provider ${providerId} cannot build a V4 imageModel`);
  }
  return createProviderV4ImageInvoke(providerId, loaded);
}
