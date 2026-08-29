import { z } from 'zod';

export const CPA_DEFAULT_IMAGE_MODEL = 'gpt-image-2';

const nullableString = z.string().nullable().optional();
const nullableInt = z.number().int().nullable().optional();

const imageSourceSchema = z.union([z.object({ image_url: z.string() }), z.object({ file_id: z.string() })]);

const imageRequestFields = {
  model: z.union([z.string(), z.null()]).optional(),
  prompt: z.string(),
  n: nullableInt,
  size: nullableString,
  quality: nullableString,
  response_format: z.enum(['url', 'b64_json']).nullable().optional(),
  stream: z.boolean().nullable().optional(),
  partial_images: nullableInt,
  output_format: nullableString,
  output_compression: z.number().nullable().optional(),
  background: nullableString,
  moderation: nullableString,
  style: nullableString,
  user: nullableString,
};

const OpenAIImageGenerationsInputSchema = z.compile(z.object(imageRequestFields).superRefine(refineImageN));

const OpenAIImageEditsInputSchema = z.compile(
  z
    .object({
      ...imageRequestFields,
      images: z.array(imageSourceSchema).min(1),
      mask: imageSourceSchema.nullable().optional(),
    })
    .superRefine(refineImageN),
);

export type OpenAIImageSourceRef = {
  readonly image_url?: string;
  readonly file_id?: string;
};

export type OpenAIImageUpload = {
  readonly data: Uint8Array;
  readonly byteLength: number;
  readonly fieldName?: string;
  readonly filename?: string;
  readonly mediaType?: string;
};

export type OpenAIImageRequest = {
  readonly model: string;
  readonly modelDefaulted: boolean;
  readonly clientModel?: string;
  readonly prompt: string;
  readonly n: number | null;
  readonly size?: string | null;
  readonly quality?: string | null;
  readonly response_format?: 'url' | 'b64_json' | null;
  readonly stream?: boolean | null;
  readonly partial_images?: number | null;
  readonly output_format?: string | null;
  readonly output_compression?: number | null;
  readonly background?: string | null;
  readonly moderation?: string | null;
  readonly style?: string | null;
  readonly user?: string | null;
  readonly images?: readonly OpenAIImageSourceRef[];
  readonly mask?: OpenAIImageSourceRef;
  readonly uploads?: readonly OpenAIImageUpload[];
  readonly maskUpload?: OpenAIImageUpload;
  readonly formFields?: Readonly<Record<string, string>>;
};

export function parseOpenAIImageGenerations(input: unknown): OpenAIImageRequest {
  return toImageRequest(OpenAIImageGenerationsInputSchema.parse(input));
}

export function parseOpenAIImageEdits(input: unknown): OpenAIImageRequest {
  const value = OpenAIImageEditsInputSchema.parse(input);
  return {
    ...toImageRequest(value),
    images: value.images,
    ...(value.mask == null ? {} : { mask: value.mask }),
  };
}

function toImageRequest(value: z.infer<typeof OpenAIImageGenerationsInputSchema>): OpenAIImageRequest {
  const modelDefaulted = isDefaultedImageModel(value.model);
  const clientModel = modelDefaulted || typeof value.model !== 'string' ? undefined : value.model;
  return {
    model: lookupImageModel(value.model),
    modelDefaulted,
    ...(clientModel === undefined ? {} : { clientModel }),
    prompt: value.prompt,
    n: value.n ?? null,
    ...(value.size === undefined ? {} : { size: value.size }),
    ...(value.quality === undefined ? {} : { quality: value.quality }),
    ...(value.response_format === undefined ? {} : { response_format: value.response_format }),
    ...(value.stream === undefined ? {} : { stream: value.stream }),
    ...(value.partial_images === undefined ? {} : { partial_images: value.partial_images }),
    ...(value.output_format === undefined ? {} : { output_format: value.output_format }),
    ...(value.output_compression === undefined ? {} : { output_compression: value.output_compression }),
    ...(value.background === undefined ? {} : { background: value.background }),
    ...(value.moderation === undefined ? {} : { moderation: value.moderation }),
    ...(value.style === undefined ? {} : { style: value.style }),
    ...(value.user === undefined ? {} : { user: value.user }),
  };
}

function refineImageN(value: { readonly model?: string | null; readonly n?: number | null }, context: z.RefinementCtx) {
  if (value.n == null) return;
  const lookup = lookupImageModel(value.model);
  if (stripOneProviderPrefix(lookup) === 'dall-e-3') {
    if (value.n !== 1) {
      context.addIssue({ code: 'custom', path: ['n'], message: 'dall-e-3 only supports n=1' });
    }
    return;
  }
  if (value.n < 1 || value.n > 10) {
    context.addIssue({ code: 'custom', path: ['n'], message: 'n must be between 1 and 10' });
  }
}

export function lookupImageModel(model: string | null | undefined): string {
  return isDefaultedImageModel(model) ? CPA_DEFAULT_IMAGE_MODEL : model!.trim();
}

export function isDefaultedImageModel(model: string | null | undefined): boolean {
  return model === undefined || model === null || model.trim() === '';
}

export function stripOneProviderPrefix(modelId: string): string {
  const index = modelId.indexOf('/');
  return index === -1 ? modelId : modelId.slice(index + 1);
}
