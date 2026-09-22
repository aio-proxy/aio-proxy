import type { RawTransport } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { XAIGrokFetch } from '../../oauth';

const API = 'https://api.x.ai/v1/videos';
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** Adapt asynchronous xAI jobs to the host's create/poll video contract. */
export function createXAIGrokVideoTransport(fetch: XAIGrokFetch, modelId: string, requestPath?: string): RawTransport {
  const urlTemplate = upstreamUrlTemplate(requestPath);
  return {
    ...(urlTemplate === undefined ? {} : { urlTemplate }),
    async invoke(request) {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path === '/v1/videos') {
        const parsed = await createBody(request, modelId);
        if (parsed instanceof Response) return parsed;
        const response = await fetch(`${API}/generations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parsed),
          signal: request.signal,
        });
        if (!response.ok) return response;
        const body: unknown = await response.json();
        if (!isPlainObject(body) || typeof body['request_id'] !== 'string' || !JOB_ID.test(body['request_id'])) {
          return failure(502, 'invalid_upstream_response', 'xAI did not return a valid video request ID');
        }
        return Response.json({ ...body, id: body['request_id'], object: 'video', status: 'queued', model: modelId });
      }
      const match = /^\/v1\/videos\/([A-Za-z0-9_-]{1,128})(\/content)?$/u.exec(path);
      if (request.method !== 'GET' || match === null) {
        return failure(501, 'unsupported_feature', 'Grok supports video creation, polling, and content retrieval');
      }
      const response = await fetch(`${API}/${match[1]}`, { signal: request.signal });
      if (!response.ok) return response;
      const body: unknown = await response.json();
      if (!isPlainObject(body) || typeof body['status'] !== 'string') {
        return failure(502, 'invalid_upstream_response', 'xAI did not return a video status');
      }
      if (match[2] !== undefined) {
        if (body['status'] !== 'done') return failure(409, 'video_not_ready', 'The video is not ready');
        const url = isPlainObject(body['video']) ? body['video']['url'] : undefined;
        if (typeof url !== 'string' || !URL.canParse(url) || new URL(url).protocol !== 'https:') {
          return failure(502, 'invalid_upstream_response', 'xAI did not return an HTTPS video URL');
        }
        // The caller downloads the signed URL; account credentials never leave the xAI API host.
        return Response.redirect(url, 302);
      }
      const status =
        body['status'] === 'done'
          ? 'completed'
          : body['status'] === 'expired'
            ? 'failed'
            : body['status'] === 'pending'
              ? 'in_progress'
              : body['status'];
      return Response.json({ ...body, id: match[1], object: 'video', model: modelId, status });
    },
  };
}

function upstreamUrlTemplate(requestPath: string | undefined): string | undefined {
  if (requestPath === '/v1/videos') return '/v1/videos/generations';
  return requestPath !== undefined && /^\/v1\/videos\/[^/]+(?:\/content)?$/u.test(requestPath)
    ? '/v1/videos/{id}'
    : undefined;
}

async function createBody(request: Request, modelId: string): Promise<Record<string, unknown> | Response> {
  let body: Record<string, unknown>;
  if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const form = await request.formData();
    body = {};
    for (const [key, value] of form) {
      if (typeof value === 'string') body[key] = value;
      else if (key === 'input_reference' && value.type.startsWith('image/')) {
        body['image'] = {
          url: `data:${value.type};base64,${Buffer.from(await value.arrayBuffer()).toString('base64')}`,
        };
      } else return failure(400, 'invalid_request_error', 'Unsupported video upload field');
    }
  } else {
    const value: unknown = await request.json();
    if (!isPlainObject(value)) return failure(400, 'invalid_request_error', 'Expected a video request object');
    body = { ...value };
  }
  body['model'] = modelId;
  if (body['seconds'] !== undefined && body['seconds'] !== null) {
    const duration = Number(body['seconds']);
    if (!Number.isFinite(duration) || duration <= 0)
      return failure(400, 'invalid_request_error', 'Invalid video duration');
    body['duration'] = duration;
  }
  delete body['seconds'];
  if (body['size'] !== undefined && body['size'] !== null) {
    const dimensions = typeof body['size'] === 'string' ? /^(\d+)x(\d+)$/u.exec(body['size']) : null;
    if (dimensions === null) return failure(400, 'invalid_request_error', 'Invalid video size');
    const width = Number(dimensions[1]);
    const height = Number(dimensions[2]);
    const ratios = [
      [16, 9],
      [9, 16],
      [1, 1],
      [4, 3],
      [3, 4],
      [3, 2],
      [2, 3],
    ] as const;
    const ratio = ratios.find(([w, h]) => width * h === height * w);
    const resolution = Math.min(width, height);
    if (ratio === undefined || ![480, 720, 1080].includes(resolution)) {
      return failure(
        400,
        'invalid_request_error',
        'Use a supported Grok aspect_ratio and resolution instead of this size',
      );
    }
    body['aspect_ratio'] = ratio.join(':');
    body['resolution'] = `${resolution}p`;
  }
  delete body['size'];
  if (body['input_reference'] !== undefined && body['input_reference'] !== null) {
    if (!isPlainObject(body['input_reference']) || typeof body['input_reference']['image_url'] !== 'string') {
      return failure(501, 'unsupported_feature', 'Grok input_reference requires an image_url or uploaded image');
    }
    body['image'] = { url: body['input_reference']['image_url'] };
  }
  delete body['input_reference'];
  return body;
}

function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
