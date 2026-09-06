import { describe, expect, test } from 'bun:test';

import { renderTranscription } from './transcription-egress';

const RESULT = {
  text: 'hello world',
  segments: [
    { text: 'hello', startSecond: 0, endSecond: 0.5 },
    { text: 'world', startSecond: 0.5, endSecond: 1.25 },
  ],
  language: 'en',
  durationInSeconds: 1.25,
};

describe('renderTranscription', () => {
  test('defaults to the json envelope', async () => {
    const response = renderTranscription(RESULT, undefined);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ text: 'hello world' });
  });

  test('adds segments and duration for verbose_json', async () => {
    const response = renderTranscription(RESULT, 'verbose_json');
    expect(await response.json()).toEqual({
      task: 'transcribe',
      language: 'en',
      duration: 1.25,
      text: 'hello world',
      segments: [
        { id: 0, start: 0, end: 0.5, text: 'hello' },
        { id: 1, start: 0.5, end: 1.25, text: 'world' },
      ],
    });
  });

  test('writes bare text for the text format', async () => {
    const response = renderTranscription(RESULT, 'text');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('hello world');
  });

  test('writes 1-based cues with comma decimals for srt', async () => {
    const response = renderTranscription(RESULT, 'srt');
    expect(response.headers.get('content-type')).toBe('application/x-subrip; charset=utf-8');
    expect(await response.text()).toBe(
      '1\n00:00:00,000 --> 00:00:00,500\nhello\n\n2\n00:00:00,500 --> 00:00:01,250\nworld\n',
    );
  });

  test('writes a WEBVTT header with dot decimals for vtt', async () => {
    const response = renderTranscription(RESULT, 'vtt');
    expect(response.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
    expect(await response.text()).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nhello\n\n00:00:00.500 --> 00:00:01.250\nworld\n',
    );
  });
});
