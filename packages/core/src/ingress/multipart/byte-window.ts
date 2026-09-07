/**
 * A growable read window over the encoded multipart stream. Slices it returns
 * alias the internal buffer, which `append`/`consume` keep replacing, so a caller
 * that retains bytes past the next read must copy them.
 */
export class ByteWindow {
  private buffer = Buffer.alloc(0);

  get byteLength(): number {
    return this.buffer.byteLength;
  }

  append(chunk: Uint8Array): void {
    this.buffer = this.buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
  }

  bytes(): Buffer {
    return this.buffer;
  }

  indexOf(needle: Uint8Array): number {
    return this.buffer.indexOf(needle);
  }

  consume(count: number): Buffer {
    const taken = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return taken;
  }

  flushExcept(keep: number): Buffer | undefined {
    if (this.buffer.byteLength <= keep) return undefined;
    return this.consume(this.buffer.byteLength - keep);
  }

  delimiterOverlap(needle: Uint8Array): number {
    const max = Math.min(this.buffer.byteLength, Math.max(0, needle.byteLength - 1));
    for (let keep = max; keep > 0; keep -= 1) {
      let matched = true;
      const start = this.buffer.byteLength - keep;
      for (let offset = 0; offset < keep; offset += 1) {
        if (this.buffer[start + offset] !== needle[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) return keep;
    }
    return 0;
  }
}
