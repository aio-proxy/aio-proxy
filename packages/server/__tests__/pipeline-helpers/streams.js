export function jsonRequest(body, options = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.contentLength !== undefined) {
    headers.set('content-length', String(options.contentLength));
  }
  return new Request('http://localhost/v1/test', {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
    method: 'POST',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
export function textStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-delta', id: 'text-1', text });
      controller.enqueue(finishPart());
      controller.close();
    },
  });
}
export function emptyStream() {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}
export function errorStream(error) {
  return new ReadableStream({
    start(controller) {
      controller.error(error);
    },
  });
}
export function textThenErrorStream(text, error) {
  let first = true;
  return new ReadableStream({
    pull(controller) {
      if (first) {
        first = false;
        controller.enqueue({ type: 'text-delta', id: 'text-1', text });
        return;
      }
      controller.error(error);
    },
  });
}
export function cancellableTextStream(text, onCancel) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-delta', id: 'text-1', text });
    },
    cancel(reason) {
      onCancel(reason);
    },
  });
}
export async function settleRecording(recording) {
  await recording.settle();
}
function finishPart() {
  return {
    type: 'finish',
    finishReason: 'stop',
    rawFinishReason: 'stop',
    totalUsage: {
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0 },
      inputTokens: 0,
      outputTokenDetails: { reasoningTokens: 0, textTokens: 0 },
      outputTokens: 0,
      totalTokens: 0,
    },
  };
}
