import { expect, test } from 'bun:test';

import { RequestBodyTooLargeError } from '../../protocol/request';
import { assertEditsMultipartCounters, parseOpenAIImageEditsMultipart } from './multipart';
import { CPA_DEFAULT_IMAGE_MODEL } from './openai-image';

const PNG_1X1_RGBA = Uint8Array.from(
  Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  ),
);

function blobFrom(bytes: Uint8Array, type = 'application/octet-stream'): Blob {
  return new Blob([bytes], { type });
}

function editsMultipartRequest(
  fields: Record<string, string | Blob | readonly Blob[]>,
  extraHeaders?: HeadersInit,
): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      form.append(name, value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) form.append(name, item);
      continue;
    }
    form.append(name, value);
  }
  return new Request('https://x/v1/images/edits', {
    method: 'POST',
    body: form,
    headers: extraHeaders,
  });
}

test.each([
  ['missing', {}],
  ['empty', { model: '' }],
  ['whitespace', { model: '  \t' }],
] as const)('defaults multipart %s model to gpt-image-2', async (_name, extra) => {
  const parsed = await parseOpenAIImageEditsMultipart(
    editsMultipartRequest({
      ...extra,
      prompt: 'make it night',
      image: blobFrom(PNG_1X1_RGBA),
    }),
  );
  expect(parsed.model).toBe(CPA_DEFAULT_IMAGE_MODEL);
  expect(CPA_DEFAULT_IMAGE_MODEL).toBe('gpt-image-2');
  expect(parsed.modelDefaulted).toBe(true);
  expect(parsed.clientModel).toBeUndefined();
});

test('treats multipart literal null as model id null', async () => {
  const parsed = await parseOpenAIImageEditsMultipart(
    editsMultipartRequest({
      model: 'null',
      prompt: 'make it night',
      image: blobFrom(PNG_1X1_RGBA),
    }),
  );
  expect(parsed.model).toBe('null');
  expect(parsed.modelDefaulted).toBe(false);
  expect(parsed.clientModel).toBe('null');
});

test('keeps a nonempty multipart model id', async () => {
  const parsed = await parseOpenAIImageEditsMultipart(
    editsMultipartRequest({
      model: 'gpt-image-1',
      prompt: 'make it night',
      image: blobFrom(PNG_1X1_RGBA),
    }),
  );
  expect(parsed.model).toBe('gpt-image-1');
  expect(parsed.modelDefaulted).toBe(false);
  expect(parsed.clientModel).toBe('gpt-image-1');
});

test('parses prompt plus image and optional mask bytes', async () => {
  const parsed = await parseOpenAIImageEditsMultipart(
    editsMultipartRequest({
      prompt: 'make it night',
      image: blobFrom(PNG_1X1_RGBA, 'text/plain'),
      mask: blobFrom(PNG_1X1_RGBA),
      n: '2',
      size: '1024x1024',
    }),
  );
  expect(parsed.prompt).toBe('make it night');
  expect(parsed.n).toBe(2);
  expect(parsed.size).toBe('1024x1024');
  expect(parsed.uploads).toHaveLength(1);
  expect(parsed.uploads?.[0]?.byteLength).toBe(PNG_1X1_RGBA.byteLength);
  expect(parsed.uploads?.[0]?.data).toEqual(PNG_1X1_RGBA);
  expect(parsed.maskUpload?.byteLength).toBe(PNG_1X1_RGBA.byteLength);
  expect(parsed.images).toBeUndefined();
  expect(parsed.mask).toBeUndefined();
});

test('accepts image[] parts up to 16 files', async () => {
  const images = Array.from({ length: 16 }, () => blobFrom(PNG_1X1_RGBA));
  const parsed = await parseOpenAIImageEditsMultipart(
    editsMultipartRequest({
      prompt: 'make it night',
      'image[]': images,
    }),
  );
  expect(parsed.uploads).toHaveLength(16);
});

test('413s a seventeenth image', async () => {
  const images = Array.from({ length: 17 }, () => blobFrom(PNG_1X1_RGBA));
  await expect(
    parseOpenAIImageEditsMultipart(
      editsMultipartRequest({
        prompt: 'make it night',
        image: images,
      }),
    ),
  ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
});

test('413s a second mask', async () => {
  const form = new FormData();
  form.append('prompt', 'make it night');
  form.append('image', blobFrom(PNG_1X1_RGBA));
  form.append('mask', blobFrom(PNG_1X1_RGBA));
  form.append('mask', blobFrom(PNG_1X1_RGBA));
  await expect(
    parseOpenAIImageEditsMultipart(new Request('https://x/v1/images/edits', { method: 'POST', body: form })),
  ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
});

test('official file counters accept 49_999_999 and the aggregate ceiling', () => {
  expect(() =>
    assertEditsMultipartCounters({
      imageCount: 16,
      maskCount: 1,
      fileByteLength: 49_999_999,
      aggregateDecoded: 849_999_983,
      nonFileFormBytes: 1_048_576,
    }),
  ).not.toThrow();
});

test.each([
  ['per-file 50_000_000', { fileByteLength: 50_000_000 }],
  ['per-file 50 MiB', { fileByteLength: 52_428_800 }],
  ['aggregate over', { aggregateDecoded: 849_999_984 }],
  ['non-file form over', { nonFileFormBytes: 1_048_577 }],
  ['17 images', { imageCount: 17 }],
  ['2 masks', { maskCount: 2 }],
] as const)('official file counters 413 %s', (_name, counters) => {
  expect(() => assertEditsMultipartCounters(counters)).toThrow(RequestBodyTooLargeError);
});

test('rejects multipart edits missing prompt or image', async () => {
  await expect(
    parseOpenAIImageEditsMultipart(editsMultipartRequest({ image: blobFrom(PNG_1X1_RGBA) })),
  ).rejects.toThrow();
  await expect(parseOpenAIImageEditsMultipart(editsMultipartRequest({ prompt: 'make it night' }))).rejects.toThrow();
});

test('413s the first oversized file without requiring later official-max parts', async () => {
  const boundary = '----oversized';
  const header = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="big.png"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const chunk = new Uint8Array(64 * 1024);
  let sentFileBytes = 0;
  let headerSent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(header);
        return;
      }
      if (sentFileBytes < 50_000_000) {
        const next = Math.min(chunk.byteLength, 50_000_000 - sentFileBytes);
        sentFileBytes += next;
        controller.enqueue(next === chunk.byteLength ? chunk : chunk.subarray(0, next));
        return;
      }
      controller.close();
    },
  });

  await expect(
    parseOpenAIImageEditsMultipart(
      new Request('https://x/v1/images/edits', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: stream,
      }),
    ),
  ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
});

test('counts unnamed parts toward the 1 MiB framing allowance', async () => {
  const boundary = '----unnamed';
  const unnamed = 'u'.repeat(1_048_577);
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake it night\r\n--${boundary}\r\nContent-Disposition: form-data\r\n\r\n${unnamed}\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="cat.png"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const encoded = Buffer.concat([header, Buffer.from(PNG_1X1_RGBA), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  await expect(
    parseOpenAIImageEditsMultipart(
      new Request('https://x/v1/images/edits', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: encoded,
      }),
    ),
  ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
});

test('counts boundaries and part headers toward the 1 MiB framing allowance', async () => {
  await expect(
    parseOpenAIImageEditsMultipart(
      editsMultipartRequest({
        prompt: 'p'.repeat(1_048_576),
        image: blobFrom(PNG_1X1_RGBA),
      }),
    ),
  ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
});
