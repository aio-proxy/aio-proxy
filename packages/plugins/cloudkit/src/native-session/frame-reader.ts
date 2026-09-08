import { MAX_FRAME_BYTES } from './protocol';

export class FrameLimitError extends Error {
  override readonly name = 'FrameLimitError';
}

export async function* readFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  let pending = new Uint8Array(0);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        if (pending.byteLength > 0) throw new Error('native stream ended with partial frame');
        return;
      }
      if (next.value.byteLength === 0) continue;
      const joined = new Uint8Array(pending.byteLength + next.value.byteLength);
      joined.set(pending);
      joined.set(next.value, pending.byteLength);
      let start = 0;
      for (let index = 0; index < joined.byteLength; index += 1) {
        if (joined[index] !== 10) continue;
        const frame = joined.subarray(start, index);
        if (frame.byteLength > MAX_FRAME_BYTES) throw new FrameLimitError('native frame exceeds 16 MiB');
        yield new TextDecoder('utf-8', { fatal: true }).decode(trimCR(frame));
        start = index + 1;
      }
      pending = joined.slice(start);
      if (pending.byteLength > MAX_FRAME_BYTES) throw new FrameLimitError('native frame exceeds 16 MiB');
    }
  } finally {
    reader.releaseLock();
  }
}

function trimCR(bytes: Uint8Array): Uint8Array {
  return bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 13 ? bytes.subarray(0, -1) : bytes;
}
