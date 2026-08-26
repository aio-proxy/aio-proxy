import { ProviderProtocol } from '@aio-proxy/types';

import { OpenAIImagesInvalidRequestError, OpenAIImagesUnsupportedFeatureError } from '../../error';
import {
  parseOpenAIImageEdits,
  parseOpenAIImageEditsMultipart,
  parseOpenAIImageGenerations,
  stripOneProviderPrefix,
  type OpenAIImageRequest,
  type OpenAIImageUpload,
} from '../../ingress/openai-image';
import { openAIImagesErrors } from '../errors';
import {
  defineImageProtocolAdapter,
  officialImageUsage,
  type ImageInvocation,
  type ImageTransportResult,
} from '../image-adapter';
import { REQUEST_BODY_LIMITS, type RequestBodyLimits, readJsonRequest, readRequestText } from '../request';
import { assertConvertMask, decodeImageBytes } from './mask';

export { CPA_DEFAULT_IMAGE_MODEL, type OpenAIImageRequest } from '../../ingress/openai-image';
export { openAIImagesErrors } from '../errors';

export type OpenAIImageOperation = 'generations' | 'edits';

export type OpenAIImageContext = {
  readonly operation: OpenAIImageOperation;
};

const DALLE_IDS = new Set(['dall-e-2', 'dall-e-3']);
const SIZE_PATTERN = /^(\d+)x(\d+)$/u;
const EDITS_JSON_LIMITS = Object.freeze({ encoded: 357_564_416, decoded: 357_564_416 });
const EDITS_MULTIPART_LIMITS = Object.freeze({ encoded: 851_048_559, decoded: 851_048_559 });
const MULTIPART_REPLAY_FIELDS = [
  'n',
  'size',
  'quality',
  'response_format',
  'stream',
  'partial_images',
  'output_format',
  'output_compression',
  'background',
  'moderation',
  'style',
  'user',
] as const satisfies readonly (keyof OpenAIImageRequest)[];
const PROVIDER_OPTION_KEYS = [
  'quality',
  'output_format',
  'output_compression',
  'background',
  'moderation',
  'style',
  'user',
] as const satisfies readonly (keyof OpenAIImageRequest)[];
const PROVIDER_OPTION_AI_SDK_KEYS = {
  quality: 'quality',
  output_format: 'outputFormat',
  output_compression: 'outputCompression',
  background: 'background',
  moderation: 'moderation',
  style: 'style',
  user: 'user',
} as const satisfies Record<(typeof PROVIDER_OPTION_KEYS)[number], string>;

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
    if (context.operation === 'edits' && isMultipartRequest(raw)) return parseOpenAIImageEditsMultipart(raw);
    const body = await readJsonRequest(raw, openaiImageBodyLimits(raw, context));
    return context.operation === 'edits' ? parseOpenAIImageEdits(body) : parseOpenAIImageGenerations(body);
  },
  model: (request) => request.model,
  wantsStream: (request) => request.stream === true,
  async rawRequest(raw, request, resolvedModel, _supportedEfforts, context) {
    if (isMultipartRequest(raw)) return rewriteMultipartRawRequest(raw, request, resolvedModel);
    const bodyText = await readRequestText(raw, openaiImageBodyLimits(raw, context));
    const rewrite = request.modelDefaulted || request.clientModel !== resolvedModel;
    const headers = stripHopHeaders(raw.headers);
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
  convertSkipReason: (request, resolvedModelId) => imageConvertSkipReason({ request, resolvedModelId }),
  errors: openAIImagesErrors,
});

function openaiImageBodyLimits(raw: Request, context: OpenAIImageContext): RequestBodyLimits {
  if (context.operation === 'edits') return isMultipartRequest(raw) ? EDITS_MULTIPART_LIMITS : EDITS_JSON_LIMITS;
  return REQUEST_BODY_LIMITS;
}

function isMultipartRequest(raw: Request): boolean {
  return (raw.headers.get('content-type') ?? '').startsWith('multipart/form-data');
}

function rewriteMultipartRawRequest(raw: Request, request: OpenAIImageRequest, resolvedModel: string): Request {
  const headers = stripHopHeaders(raw.headers);
  headers.delete('content-type');
  return new Request(raw.url, {
    method: raw.method,
    body: rebuildMultipartForm(request, resolvedModel),
    headers,
  });
}

function rebuildMultipartForm(request: OpenAIImageRequest, resolvedModel: string): FormData {
  const form = new FormData();
  const fields = request.formFields;
  if (fields === undefined) {
    form.set('model', resolvedModel);
    form.set('prompt', request.prompt);
    for (const key of MULTIPART_REPLAY_FIELDS) {
      const value = request[key];
      if (value != null) form.set(key, String(value));
    }
  } else {
    let wroteModel = false;
    for (const [name, value] of Object.entries(fields)) {
      if (name === 'model') {
        form.append('model', resolvedModel);
        wroteModel = true;
        continue;
      }
      form.append(name, value);
    }
    if (!wroteModel) form.set('model', resolvedModel);
  }
  for (const upload of request.uploads ?? []) {
    appendUpload(form, upload.fieldName ?? 'image', upload);
  }
  if (request.maskUpload !== undefined) {
    appendUpload(form, request.maskUpload.fieldName ?? 'mask', request.maskUpload);
  }
  return form;
}

function appendUpload(form: FormData, name: string, upload: OpenAIImageUpload): void {
  const bytes = Buffer.from(upload.data);
  const type = upload.mediaType === undefined ? {} : { type: upload.mediaType };
  if (upload.filename !== undefined) form.append(name, new File([bytes], upload.filename, type));
  else form.append(name, new Blob([bytes], type));
}

function stripHopHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return headers;
}

function imageEditsInvocation(request: OpenAIImageRequest): ImageInvocation {
  const feature = editsConvertUnsupportedFeature(request);
  if (feature !== undefined) throw new OpenAIImagesUnsupportedFeatureError(feature);
  const images = (request.uploads ?? []).map((upload) => decodeImageBytes(upload.data));
  const mask = request.maskUpload === undefined ? undefined : decodeImageBytes(request.maskUpload.data);
  assertConvertMask(images, mask);
  const size = convertSize(request.size);
  const providerOptions = convertProviderOptions(request);
  return {
    operation: 'edit',
    prompt: request.prompt,
    n: request.n ?? 1,
    ...(size === undefined ? {} : { size }),
    responseFormat: 'b64_json',
    ...(images.length === 0 ? {} : { images }),
    ...(mask === undefined ? {} : { mask }),
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
  if (!SIZE_PATTERN.test(size)) throw new OpenAIImagesInvalidRequestError('size');
  return size as `${number}x${number}`;
}

function convertProviderOptions(request: OpenAIImageRequest): ImageInvocation['providerOptions'] | undefined {
  const openai: Record<string, unknown> = {};
  for (const key of PROVIDER_OPTION_KEYS) {
    const value = request[key];
    if (value != null) openai[PROVIDER_OPTION_AI_SDK_KEYS[key]] = value;
  }
  return Object.keys(openai).length === 0 ? undefined : { openai };
}

function imageJson(result: ImageTransportResult): {
  readonly created: number;
  readonly data: readonly { readonly b64_json: string }[];
  readonly usage?: Readonly<Record<string, unknown>>;
} {
  const usage = officialImageUsage(result.usage);
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
