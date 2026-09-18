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
      // Carried-over bytes are newline-free by construction, so search starts at the new ones. A
      // byte-by-byte rescan of the whole buffer per chunk is quadratic in the frame size, which a
      // frame near the 16 MiB cap turns into seconds of CPU before the cap is even checked.
      let start = 0;
      for (let index = joined.indexOf(10, pending.byteLength); index !== -1; index = joined.indexOf(10, start)) {
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
