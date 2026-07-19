import { describe, expect, test } from "bun:test";

import { waitForOk } from "./cli-test-helpers";

describe("waitForOk", () => {
  test("allows a healthy response within the per-probe timeout", async () => {
    // Given
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await Bun.sleep(250);
        return new Response(null, { status: 200 });
      },
    });

    try {
      // When
      const response = await waitForOk(`http://127.0.0.1:${server.port}/health`, {
        probeTimeoutMs: 1_000,
        readinessTimeoutMs: 5_000,
      });

      // Then
      expect(response.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("retries when one health probe stalls", async () => {
    // Given
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        requests += 1;
        if (requests === 1) {
          if (!request.signal.aborted) {
            await new Promise<void>((resolve) =>
              request.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          }
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 200 });
      },
    });

    try {
      // When
      const response = await waitForOk(`http://127.0.0.1:${server.port}/health`, {
        probeTimeoutMs: 1_000,
        readinessTimeoutMs: 5_000,
      });

      // Then
      expect(response.status).toBe(200);
      expect(requests).toBeGreaterThanOrEqual(2);
    } finally {
      server.stop(true);
    }
  });

  test("caps a long probe at the readiness deadline and releases failed response bodies", async () => {
    // Given
    let failedBodyCancelled = false;
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        requests += 1;
        if (requests === 1) {
          return new Response(
            new ReadableStream({
              cancel() {
                failedBodyCancelled = true;
              },
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
            }),
            { status: 503 },
          );
        }

        if (!request.signal.aborted) {
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return new Response(null, { status: 503 });
      },
    });
    const startedAt = performance.now();

    try {
      // When / Then
      await expect(
        waitForOk(`http://127.0.0.1:${server.port}/health`, {
          probeTimeoutMs: 5_000,
          readinessTimeoutMs: 750,
        }),
      ).rejects.toThrow(`Timed out waiting for http://127.0.0.1:${server.port}/health`);
      const elapsedMs = performance.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(500);
      expect(elapsedMs).toBeLessThan(3_000);
      expect(failedBodyCancelled).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
