export async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await Bun.sleep(milliseconds);
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const abort = () => done(signal.reason);
    function done(error?: unknown): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
