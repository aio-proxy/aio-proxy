import { ProviderProtocol } from '@aio-proxy/types';

import { OpenAIImagesUnsupportedFeatureError } from '../../error';
import {
  parseOpenAIImageEdits,
  parseOpenAIImageGenerations,
  stripOneProviderPrefix,
  type OpenAIImageRequest,
} from '../../ingress/openai-image';
import { openAIImagesErrors } from '../errors';
import { defineImageProtocolAdapter, type ImageInvocation, type ImageTransportResult } from '../image-adapter';
import { REQUEST_BODY_LIMITS, type RequestBodyLimits, readJsonRequest, readRequestText } from '../request';

export { CPA_DEFAULT_IMAGE_MODEL, type OpenAIImageRequest } from '../../ingress/openai-image';
export { openAIImagesErrors } from '../errors';

export type OpenAIImageOperation = 'generations' | 'edits';

export type OpenAIImageContext = {
  readonly operation: OpenAIImageOperation;
};

const DALLE_IDS = new Set(['dall-e-2', 'dall-e-3']);
const SIZE_PATTERN = /^(\d+)x(\d+)$/u;
const EDITS_JSON_LIMITS = Object.freeze({ encoded: 357_564_416, decoded: 357_564_416 });
const PROVIDER_OPTION_KEYS = [
  'quality',
  'output_format',
  'output_compression',
  'background',
  'moderation',
  'style',
  'user',
] as const satisfies readonly (keyof OpenAIImageRequest)[];

export function imageConvertSkipReason(input: {
  readonly request: OpenAIImageRequest;
  readonly resolvedModelId: string;
}): 'stream' | 'response_format=url' | 'dall-e-3-n' | 'image_url' | 'files' | undefined {
  const { request, resolvedModelId } = input;
  if (request.stream === true) return 'stream';
  const editsFeature = editsConvertUnsupportedFeature(request);
  if (editsFeature !== undefined) return editsFeature;
  const baseId = stripOneProviderPrefix(resolvedModelId);
  const n = request.n ?? 1;
  if (baseId === 'dall-e-3' && n > 1 && stripOneProviderPrefix(request.model) !== 'dall-e-3') return 'dall-e-3-n';
  if (skipsUrlResponseFormat(baseId, request.response_format)) return 'response_format=url';
  return undefined;
}

export const openAIImagesAdapter = defineImageProtocolAdapter<OpenAIImageRequest, OpenAIImageContext>({
  protocol: ProviderProtocol.OpenAIImage,
  bodyLimits: openaiImageBodyLimits,
  async parse(raw, context) {
    const body = await readJsonRequest(raw, openaiImageBodyLimits(raw, context));
    return context.operation === 'edits' ? parseOpenAIImageEdits(body) : parseOpenAIImageGenerations(body);
  },
  model: (request) => request.model,
  wantsStream: (request) => request.stream === true,
  async rawRequest(raw, request, resolvedModel, _supportedEfforts, context) {
    const bodyText = await readRequestText(raw, openaiImageBodyLimits(raw, context));
    const rewrite = request.modelDefaulted || request.clientModel !== resolvedModel;
    const headers = new Headers(raw.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    const forwardedBody = rewrite
      ? JSON.stringify({ ...(JSON.parse(bodyText) as Record<string, unknown>), model: resolvedModel })
      : bodyText;
    return new Request(raw, {
      method: raw.method,
      body: forwardedBody,
      headers,
    });
  },
  imageInvocation: (request, context) =>
    context.operation === 'edits' ? imageEditsInvocation(request) : imageGenerationsInvocation(request),
  imageJson: async (result) => imageJson(result),
  errors: openAIImagesErrors,
});

function openaiImageBodyLimits(_raw: Request, context: OpenAIImageContext): RequestBodyLimits {
  if (context.operation === 'edits') return EDITS_JSON_LIMITS;
  return REQUEST_BODY_LIMITS;
}

function imageEditsInvocation(request: OpenAIImageRequest): ImageInvocation {
  const feature = editsConvertUnsupportedFeature(request);
  if (feature !== undefined) throw new OpenAIImagesUnsupportedFeatureError(feature);
  const size = convertSize(request.size);
  const providerOptions = convertProviderOptions(request);
  return {
    operation: 'edit',
    prompt: request.prompt,
    n: request.n ?? 1,
    ...(size === undefined ? {} : { size }),
    responseFormat: 'b64_json',
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };
}

function editsConvertUnsupportedFeature(request: OpenAIImageRequest): 'image_url' | 'files' | undefined {
  const sources = [...(request.images ?? []), ...(request.mask === undefined ? [] : [request.mask])];
  if (sources.some((source) => source.image_url !== undefined)) return 'image_url';
  if (sources.some((source) => source.file_id !== undefined)) return 'files';
  return undefined;
}

function imageGenerationsInvocation(request: OpenAIImageRequest): ImageInvocation {
  const size = convertSize(request.size);
  const providerOptions = convertProviderOptions(request);
  return {
    operation: 'generate',
    prompt: request.prompt,
    n: request.n ?? 1,
    ...(size === undefined ? {} : { size }),
    responseFormat: 'b64_json',
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };
}

function convertSize(size: string | null | undefined): `${number}x${number}` | undefined {
  if (size == null || size === 'auto') return undefined;
  return SIZE_PATTERN.test(size) ? (size as `${number}x${number}`) : undefined;
}

function convertProviderOptions(request: OpenAIImageRequest): ImageInvocation['providerOptions'] | undefined {
  const openai: Record<string, unknown> = {};
  for (const key of PROVIDER_OPTION_KEYS) {
    const value = request[key];
    if (value != null) openai[key] = value;
  }
  return Object.keys(openai).length === 0 ? undefined : { openai };
}

function imageJson(result: ImageTransportResult): {
  readonly created: number;
  readonly data: readonly { readonly b64_json: string }[];
  readonly usage?: Readonly<Record<string, unknown>>;
} {
  const usage = result.usage !== undefined && Object.keys(result.usage).length > 0 ? result.usage : undefined;
  return {
    created: result.created ?? Math.floor(Date.now() / 1000),
    data: result.images.map((bytes) => ({ b64_json: Buffer.from(bytes).toString('base64') })),
    ...(usage === undefined ? {} : { usage }),
  };
}

function skipsUrlResponseFormat(baseId: string, responseFormat: OpenAIImageRequest['response_format']): boolean {
  if (isDalleFamily(baseId)) return responseFormat !== 'b64_json';
  return responseFormat === 'url';
}

function isDalleFamily(baseId: string): boolean {
  return DALLE_IDS.has(baseId);
}
