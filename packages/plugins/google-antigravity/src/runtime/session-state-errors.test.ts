import { expect, test } from "bun:test";
import { ReasoningReplayCache } from "../protocol/replay-cache";
import { captureReasoningReplay } from "./session-state";
import { AntigravityTransport } from "./transport";

test("propagates caller cancellation while inspecting a signature-invalid response", async () => {
  const cache = new ReasoningReplayCache();
  const sessionKey = `sha256:${crypto.randomUUID()}` as const;
  const previous = cache.begin("model", sessionKey, "previous-request");
  cache.commit(previous, {
    parts: [
      {
        type: "function-call",
        contentIndex: 0,
        partIndex: 0,
        call: { id: "call-1", name: "weather", args: {} },
        signature: "signature-".repeat(6),
      },
    ],
  });
  const abort = new AbortController();
  const reason = { kind: "signature-check-cancelled" };
  let pulls = 0;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    options: { baseURL: "https://example.test" },
    replayCache: cache,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode("{"));
              return;
            }
            abort.abort(reason);
            controller.error(new Error("reader failed after cancellation"));
          },
        }),
        { status: 400 },
      ),
  });

  await expect(
    transport.execute({
      body: {
        contents: [{ role: "user", parts: [{ functionResponse: { id: "call-1", name: "weather", response: {} } }] }],
      },
      context: { requestId: crypto.randomUUID(), session: { key: sessionKey, source: "transcript" } },
      modelId: "model",
      requestType: "agent",
      signal: abort.signal,
      stream: false,
    }),
  ).rejects.toBe(reason);
});

test("propagates replay-capture cancellation without committing a partial SSE replay", async () => {
  const cache = new ReasoningReplayCache();
  const scope = cache.begin("model", "sha256:capture", "capture-request");
  const reason = { kind: "capture-cancelled" };
  let cancelled: unknown;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              response: {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: { id: "call-1", name: "weather", args: {} },
                          thoughtSignature: "signature-".repeat(6),
                        },
                      ],
                    },
                  },
                ],
              },
            })}\n\n`,
          ),
        );
      },
      cancel(value) {
        cancelled = value;
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  const captured = await captureReasoningReplay(response, "model", scope, cache);
  const reader = captured.body?.getReader();
  await reader?.read();
  await reader?.cancel(reason);
  await Promise.resolve();

  expect(cancelled).toBe(reason);
  expect(cache.read(scope.key)).toBeUndefined();
});

function credentialSource() {
  const credential = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1_900_000_000_000,
    email: "person@example.com",
    projectId: "project-1",
  };
  return { current: async () => credential, forceRefresh: async () => credential };
}
