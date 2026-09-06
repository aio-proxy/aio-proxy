import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RequestBodyTooLargeError } from '../../protocol/request';
import { multipartSpoolPath, releaseMultipartSpool } from '../multipart';
import {
  AUDIO_MULTIPART_ENCODED_LIMIT,
  AUDIO_MULTIPART_PER_FILE_LIMIT,
  parseOpenAITranscriptionMultipart,
} from './multipart';

function multipartRequest(parts: readonly string[], boundary = 'AUDIOBOUNDARY'): Request {
  const text = `${parts.map((part) => `--${boundary}\r\n${part}\r\n`).join('')}--${boundary}--\r\n`;
  return new Request('https://proxy.test/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: new TextEncoder().encode(text),
  });
}

const FILE_PART =
  'Content-Disposition: form-data; name="file"; filename="clip.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nID3AUDIO';

/**
 * Streams a single `file` part of `fileBytes` bytes without ever materializing the
 * whole body, so the envelope tests can push past a 100 MiB limit in a unit test.
 * `pulled()` reports how much of the body the reader actually consumed, which is how
 * "rejected before the whole thing reached disk" is observable from outside.
 */
function oversizedFileRequest(
  fileBytes: number,
  boundary = 'AUDIOBIG',
): { readonly request: Request; pulled(): number } {
  const header = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
  );
  const chunk = new Uint8Array(256 * 1024);
  let sent = 0;
  let headerSent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!headerSent) {
        headerSent = true;
        sent += header.byteLength;
        controller.enqueue(header);
        return;
      }
      if (sent - header.byteLength < fileBytes) {
        const next = Math.min(chunk.byteLength, fileBytes - (sent - header.byteLength));
        sent += next;
        controller.enqueue(next === chunk.byteLength ? chunk : chunk.subarray(0, next));
        return;
      }
      const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
      sent += tail.byteLength;
      controller.enqueue(tail);
      controller.close();
    },
  });
  return {
    request: new Request('https://proxy.test/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    }),
    pulled: () => sent,
  };
}

describe('parseOpenAITranscriptionMultipart', () => {
  test('reads the upload, the model, and every raw form field', async () => {
    const raw = multipartRequest([
      FILE_PART,
      'Content-Disposition: form-data; name="model"\r\n\r\nwhisper-large',
      'Content-Disposition: form-data; name="response_format"\r\n\r\nsrt',
      'Content-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nword',
      'Content-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nsegment',
    ]);
    const request = await parseOpenAITranscriptionMultipart(raw);
    expect(request.model).toBe('whisper-large');
    expect(request.modelDefaulted).toBe(false);
    expect(request.response_format).toBe('srt');
    expect(request.upload.filename).toBe('clip.mp3');
    expect(request.upload.mediaType).toBe('audio/mpeg');
    expect(new TextDecoder().decode(request.upload.data)).toBe('ID3AUDIO');
    // Raw replay must reproduce the client's own field names and repeats; the
    // normalized map cannot, so both channels are pinned here.
    expect(request.rawFormFields).toEqual([
      { name: 'model', value: 'whisper-large' },
      { name: 'response_format', value: 'srt' },
      { name: 'timestamp_granularities[]', value: 'word' },
      { name: 'timestamp_granularities[]', value: 'segment' },
    ]);
    expect(request.formFields['timestamp_granularities']).toBe('segment');
    // The plural field must carry both repeats onto the parsed request, not just the
    // last one the normalized map retained: `word` was being dropped on this path.
    expect(request.timestamp_granularities).toEqual(['word', 'segment']);
    // The body is spooled, not teed, so raw passthrough can replay it later.
    expect(multipartSpoolPath(raw)).toBeDefined();
    await releaseMultipartSpool(raw);
  });

  test('defaults a missing model to whisper-1', async () => {
    const raw = multipartRequest([FILE_PART]);
    const request = await parseOpenAITranscriptionMultipart(raw);
    expect(request.model).toBe('whisper-1');
    expect(request.modelDefaulted).toBe(true);
    await releaseMultipartSpool(raw);
  });

  test('rejects a body with no file part', async () => {
    const raw = multipartRequest(['Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1']);
    await expect(parseOpenAITranscriptionMultipart(raw)).rejects.toThrow('Invalid OpenAI Audio multipart request');
  });

  // An empty upload can never transcribe, so it is refused here rather than
  // forwarded for an upstream to answer with an opaque error.
  test('rejects a zero-byte file part', async () => {
    const raw = multipartRequest([
      'Content-Disposition: form-data; name="file"; filename="empty.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n',
    ]);
    await expect(parseOpenAITranscriptionMultipart(raw)).rejects.toThrow('Invalid OpenAI Audio multipart request');
  });

  test('rejects a request that is not multipart', async () => {
    const raw = new Request('https://proxy.test/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await expect(parseOpenAITranscriptionMultipart(raw)).rejects.toThrow('Invalid OpenAI Audio multipart request');
  });

  // Pins two things: `file` is declared in `fileFields` (drop it and the part decodes
  // as text, so this becomes the 400 the happy path rules out), and a second `file`
  // part is refused rather than silently overwriting the first. It does NOT pin WHICH
  // guard does the refusing — `singletonFileFields` and `maxFiles: 1` both raise the
  // same 413 here. The singleton rule itself is pinned in multipart-stream.test.ts.
  test('rejects a second file part instead of silently dropping one', async () => {
    const raw = multipartRequest([
      FILE_PART,
      'Content-Disposition: form-data; name="file"; filename="other.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nID3OTHER',
    ]);
    await expect(parseOpenAITranscriptionMultipart(raw)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  test('removes the spooled body when the parse fails', async () => {
    // The spool path is unreachable from outside a failed parse (nothing is
    // retained), so the reader is pointed at a private temp directory instead of
    // counting entries in the shared one, which any concurrent process pollutes.
    const previous = process.env['TMPDIR'];
    const dir = await mkdtemp(join(tmpdir(), 'aio-proxy-audio-spooltest-'));
    process.env['TMPDIR'] = dir;
    try {
      const raw = multipartRequest(['Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1']);
      await expect(parseOpenAITranscriptionMultipart(raw)).rejects.toThrow();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The schema runs after the spool exists, so a rejected field must not leave a
  // retained WeakMap entry pointing at a file the `catch` has already unlinked.
  test('retains no spool when the field schema rejects the request', async () => {
    const raw = multipartRequest([FILE_PART, 'Content-Disposition: form-data; name="temperature"\r\n\r\nhot']);
    await expect(parseOpenAITranscriptionMultipart(raw)).rejects.toThrow();
    expect(multipartSpoolPath(raw)).toBeUndefined();
  });

  // The spool writes to /tmp before the reader sees a byte, so the audio cap has to
  // reach `spoolMultipartBody` itself. Sending twice the envelope (still under the
  // 851 MB process-wide default) makes the difference observable: with the cap the
  // reader stops around 100 MiB, without it the whole 200 MiB lands on disk first.
  test('413s a body past the encoded envelope without spooling all of it', async () => {
    const oversized = oversizedFileRequest(AUDIO_MULTIPART_ENCODED_LIMIT * 2);
    await expect(parseOpenAITranscriptionMultipart(oversized.request)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(oversized.pulled()).toBeLessThan(AUDIO_MULTIPART_ENCODED_LIMIT * 1.5);
  });

  // Under the spool cap and under the aggregate, so only the reader's own per-file
  // limit can reject this. A file of exactly the limit is accepted: it is inclusive.
  test('413s a single file one byte past the per-file limit', async () => {
    const oversized = oversizedFileRequest(AUDIO_MULTIPART_PER_FILE_LIMIT + 1);
    await expect(parseOpenAITranscriptionMultipart(oversized.request)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
