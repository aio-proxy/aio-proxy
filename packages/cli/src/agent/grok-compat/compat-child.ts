export type GrokCompatCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type GrokCompatChild = {
  readonly result: Promise<GrokCompatCommandResult>;
  stdout(): string;
  stderr(): string;
  finished(): boolean;
  kill(): void;
};

export const COMPAT_KILL_GRACE_MS = 250;
export const COMPAT_STREAM_SLACK_MS = 250;

export function escalateKill(kill: () => void, abort?: AbortController): void {
  const escalate = setTimeout(() => {
    kill();
    abort?.abort();
  }, COMPAT_KILL_GRACE_MS);
  escalate.unref?.();
}

export async function consumeStream(
  stream: ReadableStream<Uint8Array> | undefined,
  sink: { text: string },
  signal?: AbortSignal,
): Promise<void> {
  if (stream === undefined) return;
  const reader = stream.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const decoder = new TextDecoder();
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) sink.text += decoder.decode(value, { stream: true });
    }
    sink.text += decoder.decode();
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function startArgv(
  argv: readonly string[],
  env: Record<string, string>,
  cwd: string,
  prefix?: readonly string[],
): GrokCompatChild {
  const command = argv[0];
  const stdoutSink = { text: '' };
  const stderrSink = { text: '' };
  if (command === undefined) {
    return {
      result: Promise.resolve({ exitCode: 1, stdout: '', stderr: 'missing command' }),
      stdout: () => '',
      stderr: () => 'missing command',
      finished: () => true,
      kill() {},
    };
  }
  const launched = prefix === undefined ? [command, ...argv.slice(1)] : [...prefix, command, ...argv.slice(1)];
  const child = Bun.spawn([launched[0]!, ...launched.slice(1)], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const abort = new AbortController();
  let done = false;
  let escalating = false;
  const result = Promise.all([
    consumeStream(child.stdout, stdoutSink, abort.signal),
    consumeStream(child.stderr, stderrSink, abort.signal),
    child.exited,
  ]).then(([, , exitCode]) => ({ exitCode, stdout: stdoutSink.text, stderr: stderrSink.text }));
  void result.finally(() => {
    done = true;
  });
  return {
    result,
    stdout: () => stdoutSink.text,
    stderr: () => stderrSink.text,
    finished: () => done,
    kill() {
      try {
        child.kill();
      } catch {}
      if (escalating || done) return;
      escalating = true;
      escalateKill(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, abort);
    },
  };
}

export async function spawnArgv(
  argv: readonly string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
  prefix?: readonly string[],
): Promise<GrokCompatCommandResult> {
  const child = startArgv(argv, env, cwd, prefix);
  let timedOut = false;
  const termTimer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const hardMs = timeoutMs + COMPAT_KILL_GRACE_MS + COMPAT_STREAM_SLACK_MS;
  let resolveHard: ((value: undefined) => void) | undefined;
  const hardTimer = setTimeout(() => {
    timedOut = true;
    child.kill();
    resolveHard?.(undefined);
  }, hardMs);
  const hardDeadline = new Promise<undefined>((resolve) => {
    resolveHard = resolve;
  });
  try {
    const command = await Promise.race([child.result, hardDeadline]);
    if (timedOut || command === undefined) {
      child.kill();
      return {
        exitCode: command === undefined || command.exitCode === 0 ? 124 : command.exitCode,
        stdout: command?.stdout ?? child.stdout(),
        stderr: `${command?.stderr ?? child.stderr()}\ncompat command timed out after ${timeoutMs}ms`,
      };
    }
    return command;
  } finally {
    clearTimeout(termTimer);
    clearTimeout(hardTimer);
  }
}
