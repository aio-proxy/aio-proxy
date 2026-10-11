import { isInboundAbort } from '../../route-observation';
import { createBodyCapture } from '../wire/body-capture';

export type BodyTapOutcome = 'complete' | 'cancelled' | 'error';

export type BodyTapTerminal = {
  readonly byteLength: number;
  readonly error?: unknown;
  readonly outcome: BodyTapOutcome;
  readonly truncated?: boolean;
  readonly captureLimitBytes?: number;
};

export type BodyTapObserver = {
  readonly chunk: (text: string) => void;
  /** Full text for business observers; diagnostic budgets never suppress it. */
  readonly text?: (text: string) => void;
  readonly terminal: (terminal: BodyTapTerminal) => void;
  readonly sourceRead?: (byteLength: number) => void;
  readonly sseFrames?: (count: number) => void;
};

export function tapTextBody(
  source: ReadableStream<Uint8Array>,
  contentType: string | null,
  observer: BodyTapObserver,
  signal?: AbortSignal,
  captureMaxBytes?: number,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  const capture = createBodyCapture(captureMaxBytes ?? 67108864);
  let textActive = true;
  let logFinished = false;
  let previousEnding = false;
  let previousCr = false;
  const sse = contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
  let buffered = '';
  let byteLength = 0;
  let diagnosticActive = true;
  let sourceReadActive = true;
  let sseFramesActive = true;
  let settled = false;
  const sourceReader = () => (reader ??= source.getReader());
  const terminal = (value: Omit<BodyTapTerminal, 'byteLength'>) => {
    if (settled) return;
    settled = true;
    try {
      observer.terminal({
        ...value,
        byteLength,
        ...(captureMaxBytes === undefined ? {} : { truncated: capture.truncated, captureLimitBytes: captureMaxBytes }),
      });
    } catch {}
  };
  const chunk = (text: string) => {
    if (!diagnosticActive || text === '') return;
    try {
      observer.chunk(text);
    } catch (error) {
      diagnosticActive = false;
      terminal({ outcome: 'error', error });
    }
  };
  const emit = (text: string, final = false) => {
    if (logFinished) return;
    if (!sse) chunk(text);
    else {
      buffered += text;
      let end: number;
      while ((end = sseEventEnd(buffered)) >= 0) {
        chunk(buffered.slice(0, end));
        buffered = buffered.slice(end);
      }
      if (final || capture.truncated || capture.capturedBytes >= (captureMaxBytes ?? 67108864)) {
        chunk(buffered);
        buffered = '';
      }
    }
    if (capture.truncated || final || capture.capturedBytes >= (captureMaxBytes ?? 67108864)) logFinished = true;
  };
  const observeText = (text: string) => {
    if (textActive && observer.text !== undefined) {
      try {
        observer.text(text);
      } catch {
        textActive = false;
      }
    }
  };
  const countFrames = (bytes: Uint8Array): number => {
    if (!sse) return 0;
    let count = 0;
    // UTF-8 continuation bytes cannot be CR/LF; count separators without retaining frame text.
    for (const byte of bytes) {
      if (byte === 10 && previousCr) {
        previousCr = false;
        continue;
      }
      previousCr = byte === 13;
      const ending = byte === 10 || previousCr;
      if (ending && previousEnding) {
        count++;
        previousEnding = false;
      } else previousEnding = ending;
    }
    return count;
  };
  const sourceRead = (value: number) => {
    if (!sourceReadActive || observer.sourceRead === undefined) return;
    try {
      observer.sourceRead(value);
    } catch {
      sourceReadActive = false;
    }
  };
  const sseFrames = (value: number) => {
    if (!sseFramesActive || observer.sseFrames === undefined) return;
    try {
      observer.sseFrames(value);
    } catch {
      sseFramesActive = false;
    }
  };

  return new ReadableStream(
    {
      async pull(controller) {
        try {
          const activeReader = sourceReader();
          const next = await activeReader.read();
          if (next.done) {
            if (observer.text !== undefined) observeText(decoder.decode());
            emit(capture.finish(), true);
            terminal({ outcome: 'complete' });
            try {
              activeReader.releaseLock();
            } catch {}
            controller.close();
            return;
          }
          byteLength += next.value.byteLength;
          controller.enqueue(next.value);
          if (next.value.byteLength > 0) sourceRead(next.value.byteLength);
          if (observer.text !== undefined) observeText(decoder.decode(next.value, { stream: true }));
          const frames = countFrames(next.value);
          emit(capture.write(next.value));
          if (next.value.byteLength > 0) sseFrames(frames);
        } catch (error) {
          const cancelled = signal !== undefined && isInboundAbort(error, signal);
          terminal(cancelled ? { outcome: 'cancelled' } : { outcome: 'error', error });
          try {
            reader?.releaseLock();
          } catch {}
          controller.error(error);
        }
      },
      async cancel(reason) {
        terminal({ outcome: 'cancelled' });
        try {
          await sourceReader().cancel(reason);
        } finally {
          try {
            reader?.releaseLock();
          } catch {}
        }
      },
    },
    { highWaterMark: 0 },
  );
}

function sseEventEnd(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    const first = lineEndingLength(text, index);
    if (first === 0) continue;
    const second = lineEndingLength(text, index + first);
    if (second > 0) return index + first + second;
    index += first - 1;
  }
  return -1;
}

function lineEndingLength(text: string, index: number): number {
  if (text[index] === '\n') return 1;
  if (text[index] !== '\r') return 0;
  return text[index + 1] === '\n' ? 2 : 1;
}
