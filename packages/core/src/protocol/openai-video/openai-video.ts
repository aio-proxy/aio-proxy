import { ProviderProtocol } from '@aio-proxy/types';

import { OpenAIVideosInvalidRequestError } from '../../error';
import {
  isJsonRequest,
  isModelField,
  isMultipartRequest,
  parseOpenAIVideoCreate,
  parseOpenAIVideoCreateMultipart,
  parseOpenAIVideoEdit,
  replaySpooledMultipartRaw,
  replaySpooledVideoFormData,
  type OpenAIVideoOperation,
  type OpenAIVideoRequest,
} from '../../ingress/openai-video';
import { stripHopHeaders } from '../headers';
import { readJsonRequest, readRequestText, REQUEST_BODY_LIMITS } from '../request';
import { defineVideoProtocolAdapter } from '../video-adapter';
import { openAIVideosErrors } from './errors';

export type OpenAIVideoContext = {
  readonly operation: OpenAIVideoOperation;
};

export const openAIVideosAdapter = defineVideoProtocolAdapter<OpenAIVideoRequest, OpenAIVideoContext>({
  protocol: ProviderProtocol.OpenAIVideo,
  bodyLimits: () => REQUEST_BODY_LIMITS,
  async parse(raw, context) {
    if (context.operation !== 'create' && isMultipartRequest(raw)) {
      throw new OpenAIVideosInvalidRequestError('content_type');
    }
    if (context.operation === 'create' && isMultipartRequest(raw)) return parseOpenAIVideoCreateMultipart(raw);
    if (!isJsonRequest(raw) && !isMultipartRequest(raw)) throw new OpenAIVideosInvalidRequestError('content_type');
    const body = await readJsonRequest(raw, REQUEST_BODY_LIMITS);
    return context.operation === 'create' ? parseOpenAIVideoCreate(body) : parseOpenAIVideoEdit(body);
  },
  model: (request) => request.model,
  wantsStream: () => false,
  async rawRequest(raw, request, resolvedModel) {
    const rewrite = request.modelDefaulted || request.clientModel !== resolvedModel;
    if (isMultipartRequest(raw)) {
      const form = await replaySpooledVideoFormData(raw);
      // Parsing keeps the LAST `model`/`model[]` spelling. An upstream parser may
      // keep the first repeat or ignore the bracketed name, so verbatim replay is
      // only safe for exactly one canonical `model` field.
      if (!rewrite && !hasAmbiguousModelField(form)) return replaySpooledMultipartRaw(raw);
      return rewriteMultipartRawRequest(raw, form, resolvedModel);
    }
    if (!rewrite) return raw.clone();
    const bodyText = await readRequestText(raw, REQUEST_BODY_LIMITS);
    return new Request(raw, {
      method: raw.method,
      body: JSON.stringify({ ...(JSON.parse(bodyText) as Record<string, unknown>), model: resolvedModel }),
      headers: stripHopHeaders(raw.headers),
    });
  },
  errors: openAIVideosErrors,
});

function rewriteMultipartRawRequest(raw: Request, form: FormData, resolvedModel: string): Request {
  const next = new FormData();
  for (const [name, value] of form.entries()) {
    if (isModelField(name)) continue;
    next.append(name, value);
  }
  next.append('model', resolvedModel);
  const headers = stripHopHeaders(raw.headers);
  headers.delete('content-type');
  return new Request(raw.url, { method: raw.method, body: next, headers, signal: raw.signal });
}

function hasAmbiguousModelField(form: FormData): boolean {
  const spellings = [...form.entries()].filter(([name]) => isModelField(name));
  return spellings.length > 1 || spellings.some(([name]) => name !== 'model');
}

export type { OpenAIVideoOperation, OpenAIVideoRequest };
