import { isPlainObject } from 'es-toolkit/predicate';

import { nestedNumberField, numberField, tokenUsage, type UsageExtraction } from '../shared';

/**
 * Audio usage is whatever upstream reports and nothing more. Duration is NOT
 * converted to tokens: new-api's `common/audio.go` estimates PCM duration at
 * 24000 Hz x 2 bytes x 1 channel and bills 1000 tokens per minute, which
 * invents numbers the provider never charged. This reports `absent` and lets
 * the configured per-request fee, if any, be the only charge. A speech response
 * is binary audio, so the non-object guard also covers that body.
 */
export function openAIAudioUsage(value: unknown): UsageExtraction {
  if (!isPlainObject(value) || !isPlainObject(value['usage'])) return { kind: 'absent' };
  const usage = value['usage'];
  return tokenUsage({
    inputTokens: numberField(usage, 'input_tokens', 'inputTokens'),
    outputTokens: numberField(usage, 'output_tokens', 'outputTokens'),
    totalTokens: numberField(usage, 'total_tokens', 'totalTokens'),
    // Only the input side has an audio breakdown: a transcription's audio is the
    // input, and a speech response returns bytes rather than a usage object.
    inputAudioTokens: nestedNumberField(usage, 'input_token_details', 'audio_tokens', 'inputAudioTokens'),
  });
}
