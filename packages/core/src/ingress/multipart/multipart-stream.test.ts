import { describe, expect, test } from 'bun:test';

import { multipartBoundary, type MultipartStreamSpec, parseMultipartStream } from './multipart-stream';

const SPEC: MultipartStreamSpec = {
  fileFields: new Set(['file']),
  limits: { perFile: 1_000, aggregate: 2_000, nonFile: 1_000, maxFiles: 2 },
  syntaxError: () => new SyntaxError('Invalid multipart request'),
};

function body(boundary: string, parts: readonly string[]): ReadableStream<Uint8Array> {
  const text = `${parts.map((part) => `--${boundary}\r\n${part}\r\n`).join('')}--${boundary}--\r\n`;
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.subarray(offset, Math.min(offset + 7, bytes.length)));
      }
      controller.close();
    },
  });
}

describe('parseMultipartStream', () => {
  test('separates declared file fields from plain fields across chunk boundaries', async () => {
    const parsed = await parseMultipartStream(
      body('BOUNDARY', [
        'Content-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nAUDIOBYTES',
        'Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1',
        'Content-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nword',
      ]),
      'BOUNDARY',
      SPEC,
    );
    expect(parsed.fields).toEqual({ model: 'whisper-1', timestamp_granularities: 'word' });
    expect(parsed.uploads).toHaveLength(1);
    expect(parsed.uploads[0]?.filename).toBe('a.mp3');
    expect(parsed.uploads[0]?.mediaType).toBe('audio/mpeg');
    expect(new TextDecoder().decode(parsed.uploads[0]?.data)).toBe('AUDIOBYTES');
    expect(parsed.namedUploads['file']?.filename).toBe('a.mp3');
  });

  test('rejects a file part over the per-file limit', async () => {
    const spec: MultipartStreamSpec = { ...SPEC, limits: { ...SPEC.limits, perFile: 4 } };
    await expect(
      parseMultipartStream(
        body('B', ['Content-Disposition: form-data; name="file"; filename="a.mp3"\r\n\r\nTOOLONG']),
        'B',
        spec,
      ),
    ).rejects.toThrow('Request body too large');
  });

  test('rejects more file parts than the spec allows in total', async () => {
    const part = 'Content-Disposition: form-data; name="file"; filename="a.mp3"\r\n\r\nA';
    await expect(parseMultipartStream(body('B', [part, part, part]), 'B', SPEC)).rejects.toThrow(
      'Request body too large',
    );
  });

  test('rejects a repeated singleton file field', async () => {
    const spec: MultipartStreamSpec = { ...SPEC, singletonFileFields: new Set(['file']) };
    const part = 'Content-Disposition: form-data; name="file"; filename="a.mp3"\r\n\r\nA';
    await expect(parseMultipartStream(body('B', [part, part]), 'B', spec)).rejects.toThrow('Request body too large');
  });

  test('raises the spec syntax error when the stream ends before the closing boundary', async () => {
    const truncated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('--B\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhis'));
        controller.close();
      },
    });
    await expect(parseMultipartStream(truncated, 'B', SPEC)).rejects.toThrow('Invalid multipart request');
  });

  test('reads the boundary out of a quoted content-type', () => {
    expect(multipartBoundary('multipart/form-data; boundary="a-b-c"')).toBe('a-b-c');
  });

  // RFC 2046 lets a quoted boundary carry surrounding spaces, and the body's
  // delimiter then contains them, so trimming here would fail to find any part.
  test('keeps whitespace inside a quoted boundary and still parses the body', async () => {
    const boundary = multipartBoundary('multipart/form-data; boundary=" abc "');
    expect(boundary).toBe(' abc ');
    const parsed = await parseMultipartStream(
      body(boundary!, ['Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1']),
      boundary!,
      SPEC,
    );
    expect(parsed.fields).toEqual({ model: 'whisper-1' });
  });
});
