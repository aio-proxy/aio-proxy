import { z } from 'zod';

import { boundedRequestStream, cancelRequestBody, readRequestBytes, type RequestBodyReadOptions } from './body-reader';
import { requestContentEncoding } from './content-encoding';
import { decodeRequestBytes } from './decode-bytes';
import { streamDecodeRequestBody } from './decode-stream';
import { RequestBodyTooLargeError } from './errors';
import { currentRequestBodyLimits, type RequestBodyLimits } from './limits';

const jsonObjectSchema = z.object({}).catchall(z.unknown());

export async function readJsonRequest(
  raw: Request,
  limits: RequestBodyLimits = currentRequestBodyLimits(),
): Promise<unknown> {
  return JSON.parse(await readRequestText(raw, limits));
}

// Decode a compressed request as a bounded stream. Unencoded bodies stay
// streamed so official-max multipart edits are not buffered. Unknown encodings
// throw UnsupportedContentEncodingError before any parse.
export async function decodedRequestStream(
  raw: Request,
  limits: RequestBodyLimits = currentRequestBodyLimits(),
  options?: RequestBodyReadOptions,
): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const encoding = requestContentEncoding(raw.headers.get('content-encoding'));
    if (encoding === undefined) return boundedRequestStream(raw.body, limits, options);
    return streamDecodeRequestBody(raw.body, encoding, limits, options);
  } catch (error) {
    await cancelRequestBody(raw, error);
    throw error;
  }
}

// Read and decode a request body to text, honoring content-encoding. Callers
// that must forward the client's exact bytes (e.g. Gemini raw passthrough, which
// rewrites the model in the URL rather than the body) reuse this text verbatim.
export async function readRequestText(
  raw: Request,
  limits: RequestBodyLimits = currentRequestBodyLimits(),
): Promise<string> {
  const branches = [raw];
  try {
    const encoding = requestContentEncoding(raw.headers.get('content-encoding'));
    const branch = raw.clone();
    branches.push(branch);
    const encoded = await readRequestBytes(branch.body, limits.encoded);
    if (encoding === undefined && encoded.byteLength > limits.decoded) {
      throw new RequestBodyTooLargeError('Request body too large', {
        stage: 'decoded',
        limitBytes: limits.decoded,
        measurement: 'observed_lower_bound',
        bytes: encoded.byteLength,
      });
    }
    const bytes = encoding === undefined ? encoded : await decodeRequestBytes(encoded, encoding, limits.decoded);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    await Promise.all(branches.map((request) => cancelRequestBody(request, error)));
    throw error;
  }
}

export async function rewriteJsonRequestModel(raw: Request, modelId: string): Promise<Request> {
  const body = jsonObjectSchema.parse(await readJsonRequest(raw));
  const headers = new Headers(raw.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Request(raw, {
    method: raw.method,
    body: JSON.stringify({ ...body, model: modelId }),
    headers,
  });
}
