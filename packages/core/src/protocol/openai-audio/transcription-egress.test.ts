import { describe, expect, test } from 'bun:test';

import { renderTranscription, RENDERABLE_TRANSCRIPTION_FORMATS } from './transcription-egress';

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

  // Rendering these locally needs segments, and no upstream format can be demanded
  // through `transcribe()`, so a segment-less candidate would answer an empty
  // subtitle body. Keeping them out of the set makes the convert path 501 instead.
  test.each(['srt', 'vtt'] as const)('does not claim it can render %s', (format) => {
    expect(RENDERABLE_TRANSCRIPTION_FORMATS.has(format)).toBe(false);
    expect(() => renderTranscription(RESULT, format)).toThrow(`cannot render response_format: ${format}`);
  });
});
