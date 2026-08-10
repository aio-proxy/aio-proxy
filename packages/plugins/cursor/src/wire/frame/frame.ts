export const CONNECT_END_STREAM_FLAG = 0b00000010;

export type ConnectFrame = { readonly flags: number; readonly payload: Uint8Array };

export type ConnectEndStream = { error?: { code: string; message: string } };

export function frameConnectMessage(data: Uint8Array, flags = 0): Uint8Array {
  const frame = new Uint8Array(5 + data.length);
  frame[0] = flags & 0xff;
  new DataView(frame.buffer).setUint32(1, data.length);
  frame.set(data, 5);
  return frame;
}

export class ConnectFrameDecoder {
  #buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): ConnectFrame[] {
    this.#buffer = concat(this.#buffer, chunk);
    const frames: ConnectFrame[] = [];
    while (this.#buffer.length >= 5) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength);
      const length = view.getUint32(1);
      if (this.#buffer.length < 5 + length) break;
      frames.push({ flags: this.#buffer[0]!, payload: this.#buffer.slice(5, 5 + length) });
      this.#buffer = this.#buffer.slice(5 + length);
    }
    return frames;
  }

  finish(): void {
    if (this.#buffer.length !== 0) throw new Error('Truncated Cursor Connect frame');
  }
}

export function parseConnectEndStream(payload: Uint8Array): ConnectEndStream {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { error: { code: 'unknown', message: 'Failed to parse Connect end stream' } };
  }
  const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (!error) return {};
  return {
    error: {
      code: typeof error.code === 'string' ? error.code : 'unknown',
      message: typeof error.message === 'string' ? error.message : 'Unknown error',
    },
  };
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}
