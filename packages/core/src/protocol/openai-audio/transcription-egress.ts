import type { TranscriptionResultData, TranscriptionSegment } from '../audio-adapter';

// OpenAI's four documented transcription response formats plus the default.
// `srt` and `vtt` are why audio egress must be able to answer with a non-JSON
// body: every reference project that supports them passes bytes through rather
// than re-encoding, and the convert path has to render them locally.
export function renderTranscription(
  result: TranscriptionResultData,
  responseFormat: string | null | undefined,
): Response {
  switch (responseFormat) {
    case 'text':
      return new Response(result.text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    case 'srt':
      return new Response(srt(result.segments), {
        headers: { 'content-type': 'application/x-subrip; charset=utf-8' },
      });
    case 'vtt':
      return new Response(vtt(result.segments), { headers: { 'content-type': 'text/vtt; charset=utf-8' } });
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
    default:
      return Response.json({ text: result.text });
  }
}

function srt(segments: readonly TranscriptionSegment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${timestamp(segment.startSecond, ',')} --> ${timestamp(segment.endSecond, ',')}\n${segment.text}\n`,
    )
    .join('\n');
}

function vtt(segments: readonly TranscriptionSegment[]): string {
  const cues = segments
    .map(
      (segment) => `${timestamp(segment.startSecond, '.')} --> ${timestamp(segment.endSecond, '.')}\n${segment.text}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${cues}`;
}

function timestamp(seconds: number, decimalSeparator: ',' | '.'): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const secs = totalSeconds % 60;
  const totalMinutes = (totalSeconds - secs) / 60;
  const minutes = totalMinutes % 60;
  const hours = (totalMinutes - minutes) / 60;
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}${decimalSeparator}${pad(ms, 3)}`;
}
