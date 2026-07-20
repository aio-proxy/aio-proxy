import { createServer } from "@aio-proxy/server";
import { describe, expect, test } from "bun:test";

import { loopbackServer } from "../src/dashboard-auth/test-support";
import { createDashboardEventHub } from "../src/dashboard-events";

const decoder = new TextDecoder();

async function readNextEventText(stream: Response, timeoutMs = 1_000): Promise<string> {
  const reader = stream.body?.getReader();
  if (reader === undefined) {
    throw new Error("dashboard event stream body is missing");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("timed out waiting for dashboard event")), timeoutMs);
  });

  try {
    const chunk = await Promise.race([reader.read(), deadline]);
    return chunk.done ? "" : decoder.decode(chunk.value);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await reader.cancel();
  }
}

describe("dashboard event hub", () => {
  test("Given canceled event stream When hub closes Then close is idempotent", async () => {
    // Given
    const hub = createDashboardEventHub();
    const stream = new Response(hub.stream());
    const reader = stream.body?.getReader();

    // When
    await reader?.cancel();

    // Then
    expect(() => hub.close()).not.toThrow();
  });

  test("Given slow dashboard event consumer When queue overflows Then dropped event is emitted and stream closes", async () => {
    // Given
    const app = await createServer({
      config: { providers: {} },
      eventLimits: { maxEvents: 1, maxBytes: 1_024 },
    });
    const stream = await app.request("/dashboard/api/events", undefined, loopbackServer);

    // When
    await app.request(
      "/dashboard/api/reload",
      {
        headers: { Origin: "http://127.0.0.1:22078" },
        method: "POST",
      },
      loopbackServer,
    );
    await app.request(
      "/dashboard/api/reload",
      {
        headers: { Origin: "http://127.0.0.1:22078" },
        method: "POST",
      },
      loopbackServer,
    );
    const text = await stream.text();

    // Then
    expect(stream.status).toBe(200);
    expect(text).toContain("event: events.dropped");
    expect(text).toContain('"queuedEvents":1');
  });

  test("Given many trace deltas for one trace When events flush Then only latest delta is emitted", async () => {
    // Given
    const hub = createDashboardEventHub();
    const stream = new Response(hub.stream());

    try {
      // When
      hub.publish({
        event: "trace.delta",
        data: { trace_id: "trace-1", textDelta: "first" },
      });
      hub.publish({
        event: "trace.delta",
        data: { trace_id: "trace-1", textDelta: "second" },
      });
      const text = await readNextEventText(stream);

      // Then
      expect(text).not.toContain("first");
      expect(text).toContain("second");
    } finally {
      hub.close();
    }
  });

  test("Given trace lifecycle events When published Then dashboard SSE emits start and end", async () => {
    // Given
    const hub = createDashboardEventHub();
    const stream = new Response(hub.stream());

    try {
      // When
      hub.publish({
        event: "trace.start",
        data: {
          modelId: "gpt-test",
          providerId: "openai",
          trace_id: "trace-1",
        },
      });
      hub.publish({
        event: "trace.end",
        data: {
          trace_id: "trace-1",
          usage: {
            providerId: "openai",
            modelId: "gpt-test",
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
          },
        },
      });
      hub.close();
      const text = await stream.text();

      // Then
      expect(text).toContain("event: trace.start");
      expect(text).toContain('"providerId":"openai"');
      expect(text).toContain("event: trace.end");
      expect(text).toContain('"totalTokens":3');
    } finally {
      hub.close();
    }
  });
});
