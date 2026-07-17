const SSE_RESPONSE_INIT = {
  headers: {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
  },
} as const;

export function createSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, SSE_RESPONSE_INIT);
}

export function retainResponseBody(response: Response, release: () => void): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    reader.releaseLock();
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          settle();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
  });
  return new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText });
}

export async function preflightStream<T>(stream: ReadableStream<T>): Promise<ReadableStream<T>> {
  const reader = stream.getReader();
  let released = false;
  const releaseReader = () => {
    if (!released) {
      reader.releaseLock();
      released = true;
    }
  };
  let first: Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>;
  try {
    first = await reader.read();
  } catch (error) {
    releaseReader();
    throw error;
  }
  if (first.done) {
    releaseReader();
    throw new Error("Upstream model stream ended before the first event");
  }
  let firstPending = true;

  return new ReadableStream<T>({
    async pull(controller) {
      if (firstPending) {
        firstPending = false;
        controller.enqueue(first.value);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          releaseReader();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });
}
