import { isNodeError } from "./fs";

export const PROCESS_STARTTIME_TIMEOUT = Symbol("process-starttime-timeout");

const PROCESS_STARTTIME_WAIT_MS = 250;
const PROCESS_STARTTIME_CLEANUP_WAIT_MS = 250;

function observe<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  return promise;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return !isNodeError(error, "ESRCH");
  }
}

export async function withinProcessStarttimeDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof PROCESS_STARTTIME_TIMEOUT> {
  observe(promise);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof PROCESS_STARTTIME_TIMEOUT>((resolve) => {
        timeout = setTimeout(() => resolve(PROCESS_STARTTIME_TIMEOUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function settleProcessStarttimeCleanup(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  try {
    await withinProcessStarttimeDeadline(promise, timeoutMs);
  } catch {}
}

function drainProcessStdout(stdout: ReadableStream<Uint8Array> | null): {
  readonly result: Promise<string>;
  readonly cancel: () => Promise<void>;
} {
  if (stdout === null) return { result: Promise.resolve(""), cancel: async () => {} };
  const reader = stdout.getReader();
  const result = observe(
    (async () => {
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) return text + decoder.decode();
          text += decoder.decode(part.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    })(),
  );
  return {
    result,
    cancel: () => observe(Promise.resolve().then(() => reader.cancel())),
  };
}

export async function processStarttime(pid: number): Promise<string | null> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
  const stdout = drainProcessStdout(child.stdout);
  const inspection = observe(Promise.all([stdout.result, child.exited]));
  const result = await withinProcessStarttimeDeadline(inspection, PROCESS_STARTTIME_WAIT_MS);
  if (result !== PROCESS_STARTTIME_TIMEOUT) {
    const [text, code] = result;
    if (code !== 0) return null;
    const trimmed = text.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  try {
    child.kill(9);
  } catch {}
  await Promise.all([
    settleProcessStarttimeCleanup(child.exited, PROCESS_STARTTIME_CLEANUP_WAIT_MS),
    settleProcessStarttimeCleanup(stdout.result, PROCESS_STARTTIME_CLEANUP_WAIT_MS),
    settleProcessStarttimeCleanup(stdout.cancel(), PROCESS_STARTTIME_CLEANUP_WAIT_MS),
  ]);
  return null;
}
