import type { ProviderV4 } from '@ai-sdk/provider';
import { generateImage } from 'ai';

import { AiSdkProviderError } from '../error';
import { officialImageUsage, type ImageInvocation, type ImageTransportResult } from '../protocol/image-adapter';

export type GenerateImageFn = (options: {
  readonly model: unknown;
  readonly prompt: string;
  readonly files?: readonly Uint8Array[];
  readonly mask?: Uint8Array;
  readonly n?: number;
  readonly size?: `${number}x${number}`;
  readonly providerOptions?: ImageInvocation['providerOptions'];
  readonly abortSignal?: AbortSignal;
}) => Promise<{
  readonly images: ReadonlyArray<string | Uint8Array | { readonly uint8Array: Uint8Array }>;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly responses?: ReadonlyArray<{ readonly timestamp?: Date }>;
}>;

export type ProviderV4ImageInvoke = (request: {
  readonly modelId: string;
  readonly invocation: ImageInvocation;
  readonly signal?: AbortSignal;
}) => Promise<ImageTransportResult>;

type GenerateImageCall = Parameters<typeof generateImage>[0];

const defaultGenerate: GenerateImageFn = (options) =>
  generateImage({
    model: options.model as GenerateImageCall['model'],
    prompt:
      options.files === undefined
        ? options.prompt
        : {
            text: options.prompt,
            images: [...options.files],
            ...(options.mask === undefined ? {} : { mask: options.mask }),
          },
    n: options.n,
    ...(options.size === undefined ? {} : { size: options.size }),
    ...(options.providerOptions === undefined
      ? {}
      : { providerOptions: options.providerOptions as GenerateImageCall['providerOptions'] }),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  });

export function createProviderV4ImageInvoke(
  providerId: string,
  provider: ProviderV4,
  generate: GenerateImageFn = defaultGenerate,
): ProviderV4ImageInvoke {
  return async (request) => {
    try {
      const model = provider.imageModel(request.modelId);
      const providerOptions = imageProviderOptions(request.invocation.providerOptions, model);
      const result = await generate({
        model,
        prompt: request.invocation.prompt,
        ...(request.invocation.operation === 'edit' ? editFiles(request.invocation) : {}),
        n: request.invocation.n,
        ...(request.invocation.size === undefined ? {} : { size: request.invocation.size }),
        ...(providerOptions === undefined ? {} : { providerOptions }),
        ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
      });
      const usage = officialImageUsage(result.usage);
      const created = unixCreated(result.responses);
      return {
        images: result.images.map(imageBytes),
        ...(usage === undefined ? {} : { usage }),
        ...(created === undefined ? {} : { created }),
      };
    } catch (error) {
      throw new AiSdkProviderError(providerId, error);
    }
  };
}

function imageProviderOptions(
  options: ImageInvocation['providerOptions'] | undefined,
  model: ReturnType<ProviderV4['imageModel']>,
): ImageInvocation['providerOptions'] | undefined {
  const compatible = options?.['openaiCompatible'];
  const namespace = imageProviderNamespace(model);
  if (
    options === undefined ||
    compatible === undefined ||
    namespace === undefined ||
    options[namespace] !== undefined
  ) {
    return options;
  }
  return { ...options, [namespace]: compatible };
}

function imageProviderNamespace(model: ReturnType<ProviderV4['imageModel']>): string | undefined {
  const provider = Reflect.get(model, 'provider');
  if (typeof provider !== 'string') return undefined;
  const namespace = provider.split('.')[0]?.trim();
  return namespace === undefined || namespace === '' ? undefined : namespace;
}

function editFiles(invocation: ImageInvocation): { readonly files: readonly Uint8Array[]; readonly mask?: Uint8Array } {
  return {
    files: (invocation.images ?? []).map((image) => image.data),
    ...(invocation.mask === undefined ? {} : { mask: invocation.mask.data }),
  };
}

function imageBytes(image: string | Uint8Array | { readonly uint8Array: Uint8Array }): Uint8Array {
  if (image instanceof Uint8Array) return image;
  if (typeof image === 'object') return image.uint8Array;
  return Uint8Array.from(Buffer.from(image, 'base64'));
}

function unixCreated(responses: ReadonlyArray<{ readonly timestamp?: Date }> | undefined): number | undefined {
  const timestamp = responses?.[0]?.timestamp;
  return timestamp instanceof Date ? Math.floor(timestamp.getTime() / 1000) : undefined;
}
