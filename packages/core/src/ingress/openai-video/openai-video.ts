import { z } from 'zod';

import { OpenAIVideosInvalidRequestError } from '../../error';
import {
  acquireMultipartSlot,
  multipartBoundary,
  releaseMultipartSpool,
  replaySpooledMultipartRaw,
  retainMultipartSpool,
  spoolMultipartBody,
} from '../multipart';

export const OFFICIAL_DEFAULT_VIDEO_MODEL = 'sora-2';

export { releaseMultipartSpool, replaySpooledMultipartRaw };

const videoIdObject = z.object({ id: z.string().min(1) });

const OpenAIVideoCreateInputSchema = z.compile(
  z.object({
    model: z.union([z.string(), z.null()]).optional(),
    prompt: z.string(),
    seconds: z.union([z.string(), z.number()]).nullable().optional(),
    size: z.string().nullable().optional(),
    input_reference: z
      .union([z.object({ image_url: z.string() }), z.object({ file_id: z.string() })])
      .nullable()
      .optional(),
  }),
);

const OpenAIVideoEditInputSchema = z.compile(
  z.object({
    model: z.union([z.string(), z.null()]).optional(),
    prompt: z.string(),
    seconds: z.union([z.string(), z.number()]).nullable().optional(),
    video: videoIdObject,
  }),
);

export type OpenAIVideoOperation = 'create' | 'edits' | 'extensions';

export type OpenAIVideoRequest = {
  readonly model: string;
  readonly modelDefaulted: boolean;
  readonly clientModel?: string;
  readonly prompt: string;
  readonly seconds?: string | number | null;
  readonly size?: string | null;
  readonly sourceVideoId?: string;
  readonly formFields?: Readonly<Record<string, string>>;
};

export function parseOpenAIVideoCreate(input: unknown): OpenAIVideoRequest {
  return toVideoRequest(OpenAIVideoCreateInputSchema.parse(input));
}

export function parseOpenAIVideoEdit(input: unknown): OpenAIVideoRequest {
  const value = OpenAIVideoEditInputSchema.parse(input);
  return { ...toVideoRequest(value), sourceVideoId: value.video.id };
}

export async function parseOpenAIVideoCreateMultipart(raw: Request): Promise<OpenAIVideoRequest> {
  if (multipartBoundary(raw.headers.get('content-type') ?? '') === undefined) {
    throw new OpenAIVideosInvalidRequestError('content_type');
  }
  const releaseSlot = await acquireMultipartSlot(raw.signal);
  try {
    const spool = await spoolMultipartBody(raw, 30_000, 'aio-proxy-videos', 64 * 1_024 * 1_024);
    retainMultipartSpool(raw, spool);
    const replay = new Request(raw.url, {
      method: raw.method,
      headers: raw.headers,
      body: Bun.file(spool.path),
      signal: raw.signal,
    });
    const form = await replay.formData();
    const fields: Record<string, string> = {};
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') fields[name] = value;
    }
    const prompt = fields['prompt'];
    if (prompt === undefined || prompt.trim() === '') throw new OpenAIVideosInvalidRequestError('prompt');
    return {
      ...toVideoRequest({
        model: fields['model'],
        prompt,
        ...(fields['seconds'] === undefined ? {} : { seconds: fields['seconds'] }),
        ...(fields['size'] === undefined ? {} : { size: fields['size'] }),
      }),
      formFields: fields,
    };
  } finally {
    releaseSlot();
  }
}

function toVideoRequest(value: {
  readonly model?: string | null;
  readonly prompt: string;
  readonly seconds?: string | number | null;
  readonly size?: string | null;
}): OpenAIVideoRequest {
  if (value.prompt.trim() === '') throw new OpenAIVideosInvalidRequestError('prompt');
  const modelDefaulted = isDefaultedVideoModel(value.model);
  const clientModel = modelDefaulted || typeof value.model !== 'string' ? undefined : value.model;
  return {
    model: lookupVideoModel(value.model),
    modelDefaulted,
    ...(clientModel === undefined ? {} : { clientModel }),
    prompt: value.prompt,
    ...(value.seconds === undefined ? {} : { seconds: value.seconds }),
    ...(value.size === undefined ? {} : { size: value.size }),
  };
}

export function lookupVideoModel(model: string | null | undefined): string {
  return isDefaultedVideoModel(model) ? OFFICIAL_DEFAULT_VIDEO_MODEL : model!.trim();
}

export function isDefaultedVideoModel(model: string | null | undefined): boolean {
  return model === undefined || model === null || model.trim() === '';
}

export function isMultipartRequest(raw: Request): boolean {
  return raw.headers.get('content-type')?.toLowerCase().includes('multipart/form-data') === true;
}

export function isJsonRequest(raw: Request): boolean {
  const type = raw.headers.get('content-type')?.toLowerCase() ?? '';
  return type === '' || type.includes('application/json') || type.includes('text/json');
}
