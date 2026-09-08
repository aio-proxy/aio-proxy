import { z } from 'zod';

import { OpenAIVideosInvalidRequestError } from '../../error';
import { decodedRequestStream, REQUEST_BODY_LIMITS } from '../../protocol/request';
import {
  acquireMultipartSlot,
  multipartBoundary,
  multipartSpoolPath,
  releaseMultipartSpool,
  replaySpooledMultipartRaw,
  retainMultipartSpool,
  spoolMultipartBody,
} from '../multipart';

export const OFFICIAL_DEFAULT_VIDEO_MODEL = 'sora-2';
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export { releaseMultipartSpool, replaySpooledMultipartRaw };

const videoIdObject = z.object({ id: z.string().regex(VIDEO_ID_PATTERN) });

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

const OpenAIVideoRemixInputSchema = z.compile(z.object({ prompt: z.string() }));

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

export function parseOpenAIVideoRemix(input: unknown): { readonly prompt: string } {
  const value = OpenAIVideoRemixInputSchema.parse(input);
  if (value.prompt.trim() === '') throw new OpenAIVideosInvalidRequestError('prompt');
  return { prompt: value.prompt };
}

export async function parseOpenAIVideoCreateMultipart(raw: Request): Promise<OpenAIVideoRequest> {
  if (multipartBoundary(raw.headers.get('content-type') ?? '') === undefined) {
    throw new OpenAIVideosInvalidRequestError('content_type');
  }
  const releaseSlot = await acquireMultipartSlot(raw.signal);
  let spool: Awaited<ReturnType<typeof spoolMultipartBody>> | undefined;
  try {
    spool = await spoolMultipartBody(raw, 30_000, 'aio-proxy-videos', 64 * 1_024 * 1_024);
    const form = await formDataFromSpoolPath(raw, spool.path);
    const fields: Record<string, string> = {};
    let model: string | undefined;
    for (const [name, value] of form.entries()) {
      if (typeof value !== 'string') continue;
      fields[name] = value;
      if (isModelField(name)) model = value;
    }
    const prompt = fields['prompt'];
    if (prompt === undefined || prompt.trim() === '') throw new OpenAIVideosInvalidRequestError('prompt');
    const parsed = toVideoRequest({
      model,
      prompt,
      ...(fields['seconds'] === undefined ? {} : { seconds: fields['seconds'] }),
      ...(fields['size'] === undefined ? {} : { size: fields['size'] }),
    });
    retainMultipartSpool(raw, spool);
    return { ...parsed, formFields: fields };
  } catch (error) {
    await spool?.unlink();
    void raw.body?.cancel(error).catch(() => undefined);
    throw error;
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

export function isModelField(name: string): boolean {
  return name === 'model' || name === 'model[]';
}

export function isMultipartRequest(raw: Request): boolean {
  return raw.headers.get('content-type')?.toLowerCase().includes('multipart/form-data') === true;
}

export function isJsonRequest(raw: Request): boolean {
  const type = raw.headers.get('content-type')?.toLowerCase() ?? '';
  return type === '' || type.includes('application/json') || type.includes('text/json');
}

export async function replaySpooledVideoFormData(raw: Request): Promise<FormData> {
  const path = multipartSpoolPath(raw);
  if (path === undefined) throw new SyntaxError('Invalid OpenAI Videos multipart request');
  return await formDataFromSpoolPath(raw, path);
}

async function formDataFromSpoolPath(raw: Request, path: string): Promise<FormData> {
  const replay = new Request(raw.url, {
    method: raw.method,
    headers: raw.headers,
    body: await Bun.file(path).bytes(),
    signal: raw.signal,
  });
  const stream = await decodedRequestStream(replay, REQUEST_BODY_LIMITS, { signal: raw.signal });
  const bytes = stream === null ? new Uint8Array() : new Uint8Array(await new Response(stream).arrayBuffer());
  const headers = new Headers(raw.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  const parsed = new Request(raw.url, {
    method: raw.method,
    headers,
    body: bytes,
    signal: raw.signal,
  });
  try {
    return await parsed.formData();
  } catch {
    throw new SyntaxError('Invalid OpenAI Videos multipart request');
  }
}
