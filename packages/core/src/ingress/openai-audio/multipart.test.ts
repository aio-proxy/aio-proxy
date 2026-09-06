import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { RequestBodyTooLargeError } from '../../protocol/request';
import { multipartSpoolPath, releaseMultipartSpool } from '../multipart';
import { parseOpenAITranscriptionMultipart } from './multipart';

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

async function audioSpoolCount(): Promise<number> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith('aio-proxy-audio-')).length;
}

describe('parseOpenAITranscriptionMultipart', () => {
  test('reads the upload, the model, and every raw form field', async () => {
    const raw = multipartRequest([
      FILE_PART,
      'Content-Disposition: form-data; name="model"\r\n\r\nwhisper-large',
      'Content-Disposition: form-data; name="response_format"\r\n\r\nsrt',
      'Content-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nword',
    ]);
    const request = await parseOpenAITranscriptionMultipart(raw);
    expect(request.model).toBe('whisper-large');
    expect(request.modelDefaulted).toBe(false);
    expect(request.response_format).toBe('srt');
    expect(request.timestamp_granularities).toEqual(['word']);
    expect(request.upload.filename).toBe('clip.mp3');
    expect(request.upload.mediaType).toBe('audio/mpeg');
    expect(new TextDecoder().decode(request.upload.data)).toBe('ID3AUDIO');
    // Raw replay must be able to reproduce every field the client sent.
    expect(request.formFields['timestamp_granularities']).toBe('word');
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

  test('rejects a request that is not multipart', async () => {
    const raw = new Request('https://proxy.test/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await expect(parseOpenAITranscriptionMultipart(raw)).rejects.toThrow('Invalid OpenAI Audio multipart request');
  });

  test('rejects a second file part instead of silently dropping one', async () => {
    const raw = multipartRequest([
      FILE_PART,
      'Content-Disposition: form-data; name="file"; filename="other.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nID3OTHER',
    ]);
    await expect(parseOpenAITranscriptionMultipart(raw)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  test('removes the spooled body when the parse fails', async () => {
    const before = await audioSpoolCount();
    const raw = multipartRequest(['Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1']);
    await expect(parseOpenAITranscriptionMultipart(raw)).rejects.toThrow();
    expect(await audioSpoolCount()).toBe(before);
  });
});
