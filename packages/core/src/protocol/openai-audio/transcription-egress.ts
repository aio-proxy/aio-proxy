import type { TranscriptionResultData } from '../audio-adapter';

/**
 * The formats this file can actually render. The convert path must refuse anything
 * else BEFORE the upstream call, so the assert in `openai-audio.ts` reads this set
 * rather than keeping a second copy of the same list. Absent and `null` are not
 * members: they mean "the `json` default" and are handled by the caller passing
 * them straight through.
 *
 * `srt` and `vtt` are deliberately absent. They are pure segment renderings, and
 * `transcribe()` has no way to demand a segment-bearing upstream format:
 * @ai-sdk/openai's option schema has no `responseFormat` at all, and its
 * `gpt-4o-transcribe` models are hardcoded to plain `json`. A candidate that
 * answers without segments normalizes to `[]`, which would render as an empty
 * subtitle body that looks like success. Raw passthrough still serves both.
 */
export const RENDERABLE_TRANSCRIPTION_FORMATS: ReadonlySet<string> = new Set(['json', 'text', 'verbose_json']);

export function renderTranscription(
  result: TranscriptionResultData,
  responseFormat: string | null | undefined,
): Response {
  switch (responseFormat) {
    case 'text':
      return new Response(result.text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    case 'verbose_json':
      return Response.json({
        task: 'transcribe',
        ...(result.language === undefined ? {} : { language: result.language }),
        ...(result.durationInSeconds === undefined ? {} : { duration: result.durationInSeconds }),
        text: result.text,
        segments: result.segments.map((segment, index) => ({
          id: index,
          start: segment.startSecond,
          end: segment.endSecond,
          text: segment.text,
        })),
      });
    case 'json':
    case null:
    case undefined:
      return Response.json({ text: result.text });
    default:
      // Unreachable through the adapter: `assertConvertibleTranscription` rejects an
      // unrenderable format before the upstream call, so reaching here means a caller
      // bypassed that guard. A `TypeError` is the right shape for that programming
      // error — a client-facing error here would surface as a 500 anyway, because
      // egress runs after the transport call rather than on the request path.
      throw new TypeError(`OpenAI Audio transcription egress cannot render response_format: ${responseFormat}`);
  }
}
