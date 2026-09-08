import { describe, expect, test } from 'bun:test';

import { OpenAIVideosInvalidRequestError } from '../../error';
import { multipartSpoolPath } from '../multipart';
import {
  OFFICIAL_DEFAULT_VIDEO_MODEL,
  parseOpenAIVideoCreate,
  parseOpenAIVideoCreateMultipart,
  parseOpenAIVideoEdit,
  parseOpenAIVideoRemix,
  releaseMultipartSpool,
} from './openai-video';

describe('parseOpenAIVideoCreate', () => {
  test('omitted model looks up sora-2', () => {
    expect(parseOpenAIVideoCreate({ prompt: 'a cat' })).toEqual({
      model: OFFICIAL_DEFAULT_VIDEO_MODEL,
      modelDefaulted: true,
      prompt: 'a cat',
    });
  });

  test('null and blank model look up sora-2', () => {
    expect(parseOpenAIVideoCreate({ prompt: 'a cat', model: null }).model).toBe('sora-2');
    expect(parseOpenAIVideoCreate({ prompt: 'a cat', model: '  ' }).modelDefaulted).toBe(true);
  });

  test('explicit model is kept', () => {
    expect(parseOpenAIVideoCreate({ prompt: 'a cat', model: 'sora-2-pro' })).toMatchObject({
      model: 'sora-2-pro',
      modelDefaulted: false,
      clientModel: 'sora-2-pro',
    });
  });

  test('blank prompt is rejected', () => {
    expect(() => parseOpenAIVideoCreate({ prompt: '  ' })).toThrow(OpenAIVideosInvalidRequestError);
  });
});

describe('parseOpenAIVideoEdit', () => {
  test('reads the source video id', () => {
    expect(parseOpenAIVideoEdit({ prompt: 'warmer light', video: { id: 'video_abc' } })).toMatchObject({
      model: 'sora-2',
      sourceVideoId: 'video_abc',
      prompt: 'warmer light',
    });
  });

  test('rejects a dotted or overlong source video id', () => {
    expect(() => parseOpenAIVideoEdit({ prompt: 'warmer light', video: { id: 'not.valid' } })).toThrow();
    expect(() => parseOpenAIVideoEdit({ prompt: 'warmer light', video: { id: 'a'.repeat(129) } })).toThrow();
  });
});

describe('parseOpenAIVideoRemix', () => {
  test('blank prompt is rejected', () => {
    expect(() => parseOpenAIVideoRemix({ prompt: '  ' })).toThrow(OpenAIVideosInvalidRequestError);
  });
});

describe('parseOpenAIVideoCreateMultipart', () => {
  test('parses a valid multipart create and retains the spool', async () => {
    const form = new FormData();
    form.set('prompt', 'a cat');
    const raw = new Request('http://x/v1/videos', { method: 'POST', body: form });
    const parsed = await parseOpenAIVideoCreateMultipart(raw);
    expect(parsed).toMatchObject({ model: 'sora-2', modelDefaulted: true, prompt: 'a cat' });
    expect(multipartSpoolPath(raw)).toBeDefined();
    await releaseMultipartSpool(raw);
    expect(multipartSpoolPath(raw)).toBeUndefined();
  });

  test('malformed bytes are a client error and do not retain a spool', async () => {
    const raw = new Request('http://x/v1/videos', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=----boundary' },
      body: 'not-a-multipart-body',
    });
    await expect(parseOpenAIVideoCreateMultipart(raw)).rejects.toThrow(SyntaxError);
    expect(multipartSpoolPath(raw)).toBeUndefined();
  });

  test('a bracketed model field routes as model and keeps the last spelling', async () => {
    const boundary = 'VIDEOB';
    const text = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model[]"\r\n\r\nsora-2\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="model[]"\r\n\r\nsora-2-pro\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\na cat\r\n`,
      `--${boundary}--\r\n`,
    ].join('');
    const raw = new Request('http://x/v1/videos', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: new TextEncoder().encode(text),
    });
    const parsed = await parseOpenAIVideoCreateMultipart(raw);
    expect(parsed).toMatchObject({ model: 'sora-2-pro', modelDefaulted: false, clientModel: 'sora-2-pro' });
    await releaseMultipartSpool(raw);
  });

  test('a missing prompt unlinks the spool', async () => {
    const form = new FormData();
    form.set('model', 'sora-2');
    const raw = new Request('http://x/v1/videos', { method: 'POST', body: form });
    await expect(parseOpenAIVideoCreateMultipart(raw)).rejects.toThrow(OpenAIVideosInvalidRequestError);
    expect(multipartSpoolPath(raw)).toBeUndefined();
  });
});
