import { describe, expect, test } from 'bun:test';

import { OpenAIVideosInvalidRequestError } from '../../error';
import { OFFICIAL_DEFAULT_VIDEO_MODEL, parseOpenAIVideoCreate, parseOpenAIVideoEdit } from './openai-video';

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
});
