import { isInboundAbort } from '../../route-observation';

export type BodyTapOutcome = 'complete' | 'cancelled' | 'error';

export type BodyTapTerminal = {
  readonly byteLength: number;
  readonly error?: unknown;
  readonly outcome: BodyTapOutcome;
};

export type BodyTapObserver = {
  readonly chunk: (text: string) => void;
  readonly terminal: (terminal: BodyTapTerminal) => void;
};

export function tapTextBody(
  source: ReadableStream<Uint8Array>,
  contentType: string | null,
  observer: BodyTapObserver,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  const sse = contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
  let buffered = '';
  let byteLength = 0;
  let diagnosticActive = true;
  let settled = false;
  const sourceReader = () => (reader ??= source.getReader());
  const terminal = (value: Omit<BodyTapTerminal, 'byteLength'>) => {
    if (settled) return;
    settled = true;
    try {
      observer.terminal({ ...value, byteLength });
    } catch {}
  };
  const emit = (text: string, final = false) => {
    if (!diagnosticActive) return;
    try {
      if (!sse) {
        if (text !== '') observer.chunk(text);
        return;
      }
      buffered += text;
      let end: number;
      while ((end = sseEventEnd(buffered)) >= 0) {
        observer.chunk(buffered.slice(0, end));
        buffered = buffered.slice(end);
      }
      if (final && buffered !== '') observer.chunk(buffered);
    } catch (error) {
      diagnosticActive = false;
      terminal({ outcome: 'error', error });
    }
  };

  return new ReadableStream(
    {
      async pull(controller) {
        try {
          const activeReader = sourceReader();
          const next = await activeReader.read();
          if (next.done) {
            emit(decoder.decode(), true);
            terminal({ outcome: 'complete' });
            try {
              activeReader.releaseLock();
            } catch {}
            controller.close();
            return;
          }
          byteLength += next.value.byteLength;
          controller.enqueue(next.value);
          emit(decoder.decode(next.value, { stream: true }));
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
