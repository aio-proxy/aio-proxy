import { describe, expect, test } from 'bun:test';

import {
  CPA_DEFAULT_SPEECH_MODEL,
  CPA_DEFAULT_TRANSCRIPTION_MODEL,
  parseOpenAISpeech,
  parseOpenAITranscriptionFields,
} from './openai-audio';

describe('parseOpenAISpeech', () => {
  test('keeps the client model and records it verbatim', () => {
    const request = parseOpenAISpeech({ model: 'gpt-4o-mini-tts', input: 'hello', voice: 'alloy' });
    expect(request.model).toBe('gpt-4o-mini-tts');
    expect(request.modelDefaulted).toBe(false);
    expect(request.clientModel).toBe('gpt-4o-mini-tts');
  });

  test('defaults a missing model to tts-1', () => {
    const request = parseOpenAISpeech({ input: 'hello', voice: 'alloy' });
    expect(request.model).toBe(CPA_DEFAULT_SPEECH_MODEL);
    expect(request.modelDefaulted).toBe(true);
    expect(request.clientModel).toBeUndefined();
  });

  // `clientModel` drives the raw path's "nothing changed, replay verbatim" check.
  // Recording the trimmed value made a padded model look unchanged, so the padding
  // reached upstream and came back as model-not-found.
  test('records a padded model untrimmed so the raw path still rewrites it', () => {
    const request = parseOpenAISpeech({ model: ' tts-1 ', input: 'hello', voice: 'alloy' });
    expect(request.model).toBe('tts-1');
    expect(request.clientModel).toBe(' tts-1 ');
  });

  test('carries response_format and speed through', () => {
    const request = parseOpenAISpeech({ input: 'hi', voice: 'nova', response_format: 'opus', speed: 1.25 });
    expect(request.response_format).toBe('opus');
    expect(request.speed).toBe(1.25);
  });

  test('rejects a request without input', () => {
    expect(() => parseOpenAISpeech({ voice: 'alloy' })).toThrow();
  });

  test('rejects a request without voice', () => {
    expect(() => parseOpenAISpeech({ input: 'hi' })).toThrow();
  });
});

describe('parseOpenAITranscriptionFields', () => {
  test('coerces the multipart text encoding of numbers and repeated fields', () => {
    const parsed = parseOpenAITranscriptionFields({
      model: 'gpt-4o-transcribe',
      temperature: '0.2',
      timestamp_granularities: 'word',
      language: 'ja',
    });
    expect(parsed.model).toBe('gpt-4o-transcribe');
    expect(parsed.temperature).toBe(0.2);
    expect(parsed.timestamp_granularities).toEqual(['word']);
    expect(parsed.language).toBe('ja');
  });

  // The normalized field map keeps only the last repeat, so building the plural field
  // from it alone dropped `word` for a client that asked for both granularities.
  test('keeps every timestamp_granularities repeat in wire order', () => {
    const parsed = parseOpenAITranscriptionFields({ timestamp_granularities: 'segment' }, [
      { name: 'timestamp_granularities[]', value: 'word' },
      { name: 'timestamp_granularities[]', value: 'segment' },
    ]);
    expect(parsed.timestamp_granularities).toEqual(['word', 'segment']);
  });

  // A client may send the field with or without the PHP-style bracket suffix.
  test('accepts the unbracketed spelling of a repeated granularity', () => {
    const parsed = parseOpenAITranscriptionFields({ timestamp_granularities: 'segment' }, [
      { name: 'timestamp_granularities', value: 'word' },
      { name: 'timestamp_granularities', value: 'segment' },
    ]);
    expect(parsed.timestamp_granularities).toEqual(['word', 'segment']);
  });

  test('defaults a blank model to whisper-1 without reporting a client model', () => {
    const parsed = parseOpenAITranscriptionFields({ model: '  ' });
    expect(parsed.model).toBe(CPA_DEFAULT_TRANSCRIPTION_MODEL);
    expect(parsed.modelDefaulted).toBe(true);
    expect(parsed.clientModel).toBeUndefined();
  });

  test('records a padded model untrimmed so the raw path still rewrites it', () => {
    const parsed = parseOpenAITranscriptionFields({ model: ' whisper-1 ' });
    expect(parsed.model).toBe('whisper-1');
    expect(parsed.clientModel).toBe(' whisper-1 ');
  });

  // `Number('')`, `Number(' ')` are 0 and `Number('0x10')` is 16, so an unguarded
  // coercion would read a field the client left blank as an explicit temperature.
  test.each(['', ' ', '\t'])('treats an empty temperature part %p as not sent', (temperature) => {
    expect(parseOpenAITranscriptionFields({ temperature }).temperature).toBeUndefined();
  });

  test.each(['hot', '0x10', 'Infinity'])('rejects a non-decimal temperature %p', (temperature) => {
    expect(() => parseOpenAITranscriptionFields({ temperature })).toThrow();
  });

  // Carried so the convert path can refuse a streaming transcription explicitly.
  // Detection uses `stream_format`, never this flag.
  test.each([
    ['true', true],
    ['false', false],
  ] as const)('coerces the multipart stream flag %p', (value, expected) => {
    expect(parseOpenAITranscriptionFields({ stream: value }).stream).toBe(expected);
  });

  test.each(['', ' '])('treats an empty stream part %p as not sent', (stream) => {
    expect(parseOpenAITranscriptionFields({ stream }).stream).toBeUndefined();
  });

  test('rejects a stream flag that is not a boolean literal', () => {
    expect(() => parseOpenAITranscriptionFields({ stream: 'yes' })).toThrow();
  });
});
