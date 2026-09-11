import type { SyncCAS, SyncRead, SyncSession } from '@aio-proxy/plugin-sdk';

import { readFrames } from './frame-reader';
import {
  assertConnectResult,
  NativeSessionError,
  parseNativeReply,
  type NativeReply,
  type NativeRequest,
} from './protocol';

type NativeChild = {
  readonly stdin: { write(data: string): unknown; flush?: () => unknown; end?: () => unknown };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: string): void;
};

export type NativeSpawn = (executable: string, containerId?: string) => NativeChild;

const defaultSpawn: NativeSpawn = (executable, containerId) =>
  Bun.spawn([executable, '--stdio', '--container', containerId ?? ''], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  }) as unknown as NativeChild;

type Pending = {
  readonly op: NativeRequest['op'];
  readonly mutation: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  // Detaches this request's listener from the caller's long-lived signal. Every settlement path
  // must call it, or a session accumulates one closure per completed operation.
  readonly release: () => void;
};

export type ConnectNativeInput = {
  readonly executable: string;
  readonly containerId: string;
  readonly signal: AbortSignal;
  readonly spawn?: NativeSpawn;
};

export async function connectNative(input: ConnectNativeInput): Promise<SyncSession> {
  const child = (input.spawn ?? defaultSpawn)(input.executable, input.containerId);
  const session = new NativeSession(child);
  session.start();
  try {
    const result = await session.request('connect', { containerId: input.containerId }, input.signal, false);
    const connected = assertConnectResult(result);
    session.setMetadata(connected);
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  }
}

class NativeSession implements SyncSession {
  identityId = '';
  spaceId = '';
  maxValueBytes = 0;
  #child: NativeChild;
  #pending = new Map<string, Pending>();
  #cancelled = new Set<string>();
  #sequence = 0;
  #generation = 0;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #stop: (() => void) | undefined;
  #protocolFailed = false;

  constructor(child: NativeChild) {
    this.#child = child;
  }

  start(): void {
    // Process exit and stdout EOF are the same event on two channels. Drain and classify the
    // output first, so a helper that dies mid-frame reliably reports invalid-data instead of
    // racing into a generic exit failure — the two carry different retry semantics. #readLoop
    // never rejects, and the child's exit closes stdout, so this always settles.
    const reading = this.#readLoop();
    void this.#stderrLoop();
    void this.#child.exited.then(() => reading).then(() => this.#failAll(false, 'native process exited'));
  }

  setMetadata(value: { identityId: string; spaceId: string; maxValueBytes: number }): void {
    this.identityId = value.identityId;
    this.spaceId = value.spaceId;
    this.maxValueBytes = value.maxValueBytes;
  }

  async read(key: string, signal: AbortSignal): Promise<SyncRead> {
    const result = await this.request('read', { key }, signal, false);
    if (!result || typeof result !== 'object')
      throw new NativeSessionError('invalid-data', 'invalid native read result');
    const value = result as Record<string, unknown>;
    if (value.kind === 'absent') return { kind: 'absent' };
    if (
      value.kind !== 'present' ||
      typeof value.valueBase64 !== 'string' ||
      typeof value.version !== 'string' ||
      typeof value.modifiedAt !== 'number'
    ) {
      throw new NativeSessionError('invalid-data', 'invalid native read result');
    }
    return {
      kind: 'present',
      value: decodeBase64(value.valueBase64),
      version: value.version,
      modifiedAt: value.modifiedAt,
    };
  }

  async compareAndSwap(key: string, expected: string | null, value: Uint8Array, signal: AbortSignal): Promise<SyncCAS> {
    const result = await this.request('cas', { key, expected, valueBase64: encodeBase64(value) }, signal, true);
    if (!result || typeof result !== 'object')
      throw new NativeSessionError('invalid-data', 'invalid native CAS result');
    const output = result as Record<string, unknown>;
    if (output.kind === 'conflict') return { kind: 'conflict' };
    if (output.kind === 'written' && typeof output.version === 'string' && typeof output.modifiedAt === 'number') {
      return { kind: 'written', version: output.version, modifiedAt: output.modifiedAt };
    }
    throw new NativeSessionError('invalid-data', 'invalid native CAS result');
  }

  async list(
    input: { prefix: string; cursor?: string },
    signal: AbortSignal,
  ): Promise<{ keys: readonly string[]; nextCursor?: string }> {
    const result = await this.request('list', input, signal, false);
    if (!result || typeof result !== 'object')
      throw new NativeSessionError('invalid-data', 'invalid native list result');
    const output = result as Record<string, unknown>;
    if (!Array.isArray(output.keys) || !output.keys.every((key) => typeof key === 'string')) {
      throw new NativeSessionError('invalid-data', 'invalid native list result');
    }
    return {
      keys: output.keys,
      ...(typeof output.nextCursor === 'string' ? { nextCursor: output.nextCursor } : {}),
    };
  }

  async remove(key: string, expected: string, signal: AbortSignal): Promise<{ kind: 'removed' | 'conflict' }> {
    const result = await this.request('remove', { key, expected }, signal, true);
    if (!result || typeof result !== 'object')
      throw new NativeSessionError('invalid-data', 'invalid native remove result');
    const output = result as Record<string, unknown>;
    if (output.kind === 'removed' || output.kind === 'conflict') return output as { kind: 'removed' | 'conflict' };
    throw new NativeSessionError('invalid-data', 'invalid native remove result');
  }

  watch(onHint: () => void): () => void {
    this.#stop = onHint;
    return () => {
      if (this.#stop === onHint) this.#stop = undefined;
    };
  }

  request(
    op: NativeRequest['op'],
    input: Record<string, unknown>,
    signal: AbortSignal,
    mutation: boolean,
  ): Promise<unknown> {
    if (this.#disposed) return Promise.reject(new NativeSessionError('cancelled', 'native session is disposed'));
    if (this.#protocolFailed)
      return Promise.reject(new NativeSessionError('invalid-data', 'native session protocol failed'));
    const id = `${this.#generation}-${++this.#sequence}`;
    const request: NativeRequest = { id, op, input };
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        // The helper answers the original id from its own request task, so a cancel races the
        // reply it is meant to pre-empt. Remember the id and drop that late reply rather than
        // treating it as protocol corruption.
        if (this.#pending.delete(id)) this.#cancelled.add(id);
        try {
          this.#send({ id: `${this.#generation}-${++this.#sequence}`, op: 'cancel', input: { targetId: id } });
        } catch {
          // The operation is already being failed locally.
        }
        reject(new NativeSessionError(mutation ? 'outcome-unknown' : 'cancelled', 'native operation aborted'));
      };
      const release = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        abort();
        return;
      }
      this.#pending.set(id, { op, mutation, resolve, reject, release });
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.#send(request);
      } catch (error) {
        release();
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = (async () => {
      try {
        this.#send({ id: `${this.#generation}-${++this.#sequence}`, op: 'dispose', input: {} });
      } catch {
        // Process shutdown below is authoritative.
      }
      if (!(await this.#waitForExit(5000))) {
        this.#child.kill('SIGTERM');
        if (!(await this.#waitForExit(2000))) this.#child.kill('SIGKILL');
      }
      this.#failAll(false, 'native session disposed');
      this.#stop = undefined;
    })();
    return this.#disposePromise;
  }

  #send(request: NativeRequest): void {
    const line = `${JSON.stringify(request)}\n`;
    if (new TextEncoder().encode(line).byteLength > 16 * 1024 * 1024)
      throw new NativeSessionError('quota', 'native frame limit exceeded');
    this.#child.stdin.write(line);
    this.#child.stdin.flush?.();
  }

  async #readLoop(): Promise<void> {
    try {
      for await (const frame of readFrames(this.#child.stdout)) {
        this.#handle(parseNativeReply(frame));
      }
      this.#failAll(false, 'native output ended');
    } catch {
      this.#fenceProtocol('native output was invalid');
    }
  }

  async #stderrLoop(): Promise<void> {
    const reader = this.#child.stderr.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        // Native diagnostics are intentionally consumed and never exposed verbatim.
      }
    } finally {
      reader.releaseLock();
    }
  }

  #handle(reply: NativeReply): void {
    if ('event' in reply) {
      if (reply.event === 'change-hint') this.#stop?.();
      else {
        this.#generation += 1;
        this.#failAll(false, 'CloudKit identity changed', 'identity-changed');
        void this.dispose();
      }
      return;
    }
    const pending = this.#pending.get(reply.id);
    if (!pending) {
      if (this.#cancelled.delete(reply.id)) return;
      this.#protocolFailed = true;
      this.#failAllWithCode('invalid-data', 'unexpected or duplicate native reply');
      this.#child.kill('SIGTERM');
      return;
    }
    this.#pending.delete(reply.id);
    pending.release();
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new NativeSessionError(reply.error.code));
  }

  #failAll(mutationUnknown: boolean, message: string, code?: 'identity-changed'): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.release();
      pending.reject(
        new NativeSessionError(code ?? (mutationUnknown || pending.mutation ? 'outcome-unknown' : 'offline'), message),
      );
    }
    this.#cancelled.clear();
  }

  #failAllWithCode(code: 'offline' | 'invalid-data', message: string): void {
    if (this.#protocolFailed && code !== 'invalid-data') return;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.release();
      pending.reject(new NativeSessionError(code, message));
    }
    this.#cancelled.clear();
  }

  #fenceProtocol(message: string): void {
    this.#protocolFailed = true;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.release();
      pending.reject(new NativeSessionError(pending.mutation ? 'outcome-unknown' : 'invalid-data', message));
    }
    this.#cancelled.clear();
    this.#child.kill('SIGTERM');
  }

  async #waitForExit(timeout: number): Promise<boolean> {
    return Promise.race([
      this.#child.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeout)),
    ]);
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
