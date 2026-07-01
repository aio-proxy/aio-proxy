import { describe, expect, test } from "bun:test";
import { createServer } from "@aio-proxy/server";
import { createDashboardEventHub } from "../src/dashboard-events";

const decoder = new TextDecoder();

async function readNextEventText(
  stream: Response,
  timeoutMs = 1_000,
): Promise<string> {
  const reader = stream.body?.getReader();
  if (reader === undefined) {
    throw new Error("dashboard event stream body is missing");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReadableStreamReadResult<Uint8Array>>(
    (_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("timed out waiting for dashboard event")),
        timeoutMs,
      );
    },
  );

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
    const app = createServer({
      config: { providers: [] },
      eventLimits: { maxEvents: 1, maxBytes: 1_024 },
    });
    const stream = await app.request("/dashboard/events");

    // When
    await app.request("/dashboard/reload", {
      headers: { Origin: "http://127.0.0.1:22079" },
      method: "POST",
    });
    await app.request("/dashboard/reload", {
      headers: { Origin: "http://127.0.0.1:22079" },
      method: "POST",
    });
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
});
