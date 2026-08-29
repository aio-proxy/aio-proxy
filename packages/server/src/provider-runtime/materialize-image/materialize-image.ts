import {
  createProviderV4ImageInvoke,
  loadAiSdkProvider,
  type ProviderFetch,
  resolveApiKey,
  validateProviderV4,
} from '@aio-proxy/core';
import type { AiSdkProvider, ApiProvider, Provider, RouterModelPolicy } from '@aio-proxy/types';
import { apiProviderEndpoints, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import type { ImageTransport, ModelCapabilityIndex, RuntimeProviderInstance } from '../../runtime';
import { routerModelsGrantImage, supportsImage } from '../capability-index';

const IMAGE_BRIDGE_PACKAGES = {
  [ProviderProtocol.OpenAIImage]: '@ai-sdk/openai',
  [ProviderProtocol.OpenAICompatible]: '@ai-sdk/openai-compatible',
  [ProviderProtocol.OpenAIResponse]: '@ai-sdk/openai',
} as const;

type ImageBridgeProtocol = keyof typeof IMAGE_BRIDGE_PACKAGES;

export function attachImageTransport(
  instance: RuntimeProviderInstance,
  options: {
    readonly config: Provider;
    readonly fetch?: ProviderFetch;
    readonly routerModels?: Readonly<Record<string, RouterModelPolicy>>;
  },
): RuntimeProviderInstance {
  if (instance.image !== undefined) return instance;
  // Router policies may grant image output at request time to models the
  // upstream-id index knows nothing about, so transport creation cannot be
  // gated on the index alone.
  if (!capabilityIndexHasImage(instance.capabilityIndex) && !routerModelsGrantImage(options.routerModels)) {
    return instance;
  }
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
  const bridgeable = apiProviderEndpoints(config).filter(
    (endpoint): endpoint is typeof endpoint & { readonly protocol: ImageBridgeProtocol } =>
      endpoint.protocol in IMAGE_BRIDGE_PACKAGES,
  );
  return bridgeable.find((endpoint) => endpoint.protocol === ProviderProtocol.OpenAIImage) ?? bridgeable[0];
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
