import type { ProviderV4 } from '@ai-sdk/provider';
import { generateImage } from 'ai';

import { AiSdkProviderError } from '../error';
import type { ImageInvocation, ImageTransportResult } from '../protocol/image-adapter';

export type GenerateImageFn = (options: {
  readonly model: unknown;
  readonly prompt:
    | string
    | {
        readonly images: readonly Uint8Array[];
        readonly text?: string;
        readonly mask?: Uint8Array;
      };
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

const defaultGenerate: GenerateImageFn = (options) => generateImage(options as never);

export function createProviderV4ImageInvoke(
  providerId: string,
  provider: ProviderV4,
  generate: GenerateImageFn = defaultGenerate,
): ProviderV4ImageInvoke {
  return async (request) => {
    try {
      const result = await generate({
        model: provider.imageModel(request.modelId),
        prompt: imagePrompt(request.invocation),
        n: request.invocation.n,
        ...(request.invocation.size === undefined ? {} : { size: request.invocation.size }),
        ...(request.invocation.providerOptions === undefined
          ? {}
          : { providerOptions: request.invocation.providerOptions }),
        ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
      });
      const usage = result.usage;
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

function imagePrompt(invocation: ImageInvocation): Parameters<GenerateImageFn>[0]['prompt'] {
  if (invocation.operation !== 'edit') return invocation.prompt;
  return {
    text: invocation.prompt,
    images: (invocation.images ?? []).map((image) => image.data),
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
