import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { GoogleAntigravityCredential } from "../schema";

import { AntigravityUpstreamError } from "./errors";
import { AntigravityTransport } from "./transport";

test("custom endpoints are attempted once and errors remain secret-safe", async () => {
  const secret = "raw-upstream-secret";
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    options: { baseURL: "https://custom.example.test" },
    fetch: async () => Response.json({ error: { message: `no capacity ${secret}` } }, { status: 503 }),
  });

  const error = await rejected(transport.execute(executeInput()));

  expect(error).toBeInstanceOf(AntigravityUpstreamError);
  expect(errorSurface(error)).not.toContain(secret);
  expect(JSON.parse(JSON.stringify(error))).toEqual({
    endpoint: "custom",
    reason: "upstream_no_capacity",
    retryable: true,
    status: 503,
  });
});

test("propagates caller cancellation while inspecting a 503 body", async () => {
  const reason = { kind: "body-inspection-cancelled" };
  const abort = new AbortController();
  let requests = 0;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async () => {
      requests += 1;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            abort.abort(reason);
            controller.error(reason);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 503, headers: { "Content-Type": "application/json" } });
    },
  });

  await expect(transport.execute(executeInput({ signal: abort.signal }))).rejects.toBe(reason);
  expect(requests).toBe(1);
});

test("switches endpoint only for an explicit no-capacity error message", async () => {
  let requests = 0;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async () => {
      requests += 1;
      if (requests === 1) {
        return Response.json({ error: { message: "No capacity is available" } }, { status: 503 });
      }
      return Response.json({ response: { ok: true } });
    },
  });

  const response = await transport.execute(executeInput());

  expect(response.status).toBe(200);
  expect(requests).toBe(2);
});

test.each([
  ["phrase outside error.message", JSON.stringify({ message: "no capacity", error: { message: "busy" } })],
  ["invalid JSON", '{"error":{"message":"no capacity"'],
  ["HTML", "<html><body>no capacity</body></html>"],
] as const)("keeps a 503 terminal when no-capacity appears in %s", async (_label, body) => {
  let requests = 0;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async () => {
      requests += 1;
      return new Response(body, { status: 503 });
    },
  });

  const response = await transport.execute(executeInput());

  expect(response.status).toBe(503);
  expect(requests).toBe(1);
});

test("keeps an oversized 503 JSON body terminal", async () => {
  let requests = 0;
  const body = JSON.stringify({ error: { message: "no capacity", detail: "x".repeat(70_000) } });
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async () => {
      requests += 1;
      return new Response(body, { status: 503, headers: { "Content-Type": "application/json" } });
    },
  });

  const response = await transport.execute(executeInput());

  expect(response.status).toBe(503);
  expect(requests).toBe(1);
});

test("keeps a non-ending 503 body terminal within the inspection bound", async () => {
  const reason = { kind: "end-non-ending-body-test" };
  const abort = new AbortController();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let requests = 0;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async () => {
      requests += 1;
      const body = new ReadableStream<Uint8Array>({
        start(current) {
          controller = current;
          current.enqueue(new TextEncoder().encode('{"error":{"message":"no capacity"'));
        },
      });
      return new Response(body, { status: 503, headers: { "Content-Type": "application/json" } });
    },
  });

  const execution = transport.execute(executeInput({ signal: abort.signal }));
  const outcome = await Promise.race([execution, Bun.sleep(250).then(() => "inspection-timeout" as const)]);
  if (outcome === "inspection-timeout") {
    abort.abort(reason);
    controller?.error(reason);
    await execution.catch(() => undefined);
  } else {
    await outcome.body?.cancel();
  }

  expect(outcome).toBeInstanceOf(Response);
  expect(requests).toBe(1);
});

test("switches endpoint when SSE preflight exceeds its replay bound before commit", async () => {
  const origins: string[] = [];
  const modelEvent = 'data: {"response":{"candidates":[]}}\n\n';
  const unclassifiedEvent = `data: ${JSON.stringify({ metadata: "x".repeat(64 * 1024) })}\n\n`;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async (input) => {
      origins.push(new URL(String(input)).origin);
      return sseResponse(origins.length === 1 ? unclassifiedEvent.repeat(17) : modelEvent);
    },
  });

  const response = await transport.execute(executeInput({ stream: true }));

  expect(await response.text()).toBe(modelEvent);
  expect(origins).toEqual(["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"]);
});

test("does not switch endpoint after post-model replay capture exceeds its bound", async () => {
  const origins: string[] = [];
  const modelEvent = 'data: {"response":{"candidates":[]}}\n\n';
  const oversized = `data: ${"x".repeat(1024 * 1024 + 1)}`;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async (input) => {
      origins.push(new URL(String(input)).origin);
      return sseResponse(origins.length === 1 ? modelEvent + oversized : modelEvent);
    },
  });

  const response = await transport.execute(executeInput({ stream: true }));

  expect(await response.text()).toBe(modelEvent + oversized);
  expect(origins).toEqual(["https://daily-cloudcode-pa.googleapis.com"]);
});

test("does not switch endpoint after an unknown preflight reader failure", async () => {
  const failure = new Error("stream implementation failure");
  let requests = 0;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async () => {
      requests += 1;
      if (requests > 1) return sseResponse('data: {"response":{"candidates":[]}}\n\n');
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.error(failure);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    },
  });

  await expect(transport.execute(executeInput({ stream: true }))).rejects.toBe(failure);
  expect(requests).toBe(1);
});

function executeInput(overrides: Partial<Parameters<AntigravityTransport["execute"]>[0]> = {}) {
  return {
    body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    context: logicalContext(),
    modelId: "gemini-3-flash-agent",
    requestType: "agent" as const,
    stream: false,
    ...overrides,
  };
}

function credentialSource() {
  return { current: async () => credentialFixture(), forceRefresh: async () => credentialFixture() };
}

function credentialFixture(): GoogleAntigravityCredential {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1_900_000_000_000,
    email: "person@example.com",
    projectId: "project-1",
  };
}

function logicalContext(): LogicalRequestContext {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    session: { key: "sha256:abc", source: "transcript" },
  };
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected an Error rejection");
}

function errorSurface(error: Error): string {
  return [error.message, ...Object.values(error), JSON.stringify(error)].join(" ");
}

function sseResponse(value: string): Response {
  return new Response(value, { headers: { "Content-Type": "text/event-stream" } });
}
