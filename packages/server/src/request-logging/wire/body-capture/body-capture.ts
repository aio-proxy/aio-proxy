/** A diagnostic prefix measured at the source byte boundary, independent of forwarding. */
export function createBodyCapture(maxBytes: number): {
  write(chunk: Uint8Array): string;
  finish(): string;
  readonly truncated: boolean;
  readonly capturedBytes: number;
} {
  const decoder = new TextDecoder();
  let capturedBytes = 0;
  let truncated = false;
  let finished = false;
  return {
    write(chunk) {
      if (finished) return '';
      const length = Math.min(chunk.byteLength, Math.max(0, maxBytes - capturedBytes));
      capturedBytes += length;
      if (length < chunk.byteLength) truncated = true;
      // subarray does not retain a full chunk copy; TextDecoder retains only an incomplete character.
      return length === 0 ? '' : decoder.decode(chunk.subarray(0, length), { stream: true });
    },
    finish() {
      if (finished) return '';
      finished = true;
      // A cut UTF-8 character is omitted instead of becoming a replacement character.
      return truncated ? '' : decoder.decode();
    },
    get truncated() {
      return truncated;
    },
    get capturedBytes() {
      return capturedBytes;
    },
  };
}
