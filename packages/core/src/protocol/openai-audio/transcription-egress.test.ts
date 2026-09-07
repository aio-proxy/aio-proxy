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

  // `gpt-4o-transcribe` is pinned to plain JSON inside the SDK, so it answers with
  // neither segments nor a duration. Emitting `segments: []` would dress a degraded
  // body up as a successful verbose one; the caller turns this throw into a 501.
  test('refuses verbose_json when the transport answered in the plain shape', () => {
    expect(() => renderTranscription({ text: 'hello world', segments: [] }, 'verbose_json')).toThrow(
      'OpenAI Audio feature is not supported: response_format',
    );
  });

  // Silent audio really does transcribe to nothing, and a verbose upstream still
  // reports the duration it measured. Segment count alone would 501 a correct
  // answer, so the duration is what proves the verbose shape arrived.
  test('renders a legitimately empty verbose transcript when the duration is present', async () => {
    const response = renderTranscription({ text: '', segments: [], durationInSeconds: 0 }, 'verbose_json');
    expect(await response.json()).toEqual({ task: 'transcribe', duration: 0, text: '', segments: [] });
  });
});
