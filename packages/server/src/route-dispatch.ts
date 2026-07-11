import type { RouterResolution } from "@aio-proxy/core";
import { bridgeApiProviderToAiSdk, RouterModelNotFoundError } from "@aio-proxy/core";
import { ProviderKind } from "@aio-proxy/types";
import { z } from "zod";
import type { ProviderRouteSource, RuntimeProviderInstance } from "./runtime";

const jsonObjectSchema = z.object({}).catchall(z.unknown());

export function resolveCandidates(
  source: ProviderRouteSource,
  model: string,
  variantKey?: string,
): readonly RouterResolution<RuntimeProviderInstance>[] | RouterModelNotFoundError {
  try {
    return source.currentProviderSnapshot().router.resolve(model, variantKey);
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return error;
    }
    throw error;
  }
}

export async function rewriteJsonRequestModel(request: Request, modelId: string): Promise<Request> {
  const body = jsonObjectSchema.parse(await request.clone().json());
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, {
    body: JSON.stringify({ ...body, model: modelId }),
    headers,
  });
}

export function shouldTryNextResponse(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

export async function preflightStream<T>(stream: ReadableStream<T>): Promise<ReadableStream<T>> {
  const reader = stream.getReader();
  const first = await reader.read();
  let firstPending = !first.done;

  return new ReadableStream<T>({
    async pull(controller) {
      if (firstPending) {
        firstPending = false;
        controller.enqueue(first.value);
        return;
      }

      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function toAiSdkProvider(provider: RuntimeProviderInstance) {
  if (provider.kind === ProviderKind.AiSdk) {
    return provider;
  }

  if (provider.kind === ProviderKind.OAuth) {
    return provider;
  }

  if (provider.kind === ProviderKind.Api) {
    return bridgeApiProviderToAiSdk({
      ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      id: provider.id,
      kind: provider.kind,
      ...(provider.models === undefined ? {} : { models: [...provider.models] }),
      ...(provider.alias === undefined ? {} : { alias: provider.alias }),
      protocol: provider.protocol,
    });
  }

  return undefined;
}
