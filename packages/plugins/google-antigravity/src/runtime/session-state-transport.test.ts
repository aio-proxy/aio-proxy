import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import { type ReasoningReplay, ReasoningReplayCache } from "../protocol/replay-cache";
import { AntigravityTransport } from "./transport";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "signature-".repeat(6);
const NEWER_SIGNATURE = "newer-signature-".repeat(5);

test("retries one structured signature-invalid 400 without replay", async () => {
  const session = `sha256:retry-${crypto.randomUUID()}` as const;
  const requestId = crypto.randomUUID();
  const cache = new ReasoningReplayCache();
  const previous = cache.begin(MODEL, session, "previous-request");
  cache.commit(previous, functionCallReplay());
  const bodies: unknown[] = [];
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    options: { baseURL: "https://example.test" },
    replayCache: cache,
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        return Response.json({ error: { message: "function call has invalid thoughtSignature" } }, { status: 400 });
      }
      return Response.json({ response: { candidates: [] } });
    },
  });

  const response = await transport.execute({
    body: {
      contents: [{ role: "user", parts: [{ functionResponse: { id: "call-1", name: "weather", response: {} } }] }],
    },
    context: { requestId, session: { key: session, source: "transcript" } },
    modelId: MODEL,
    requestType: "agent",
    stream: false,
  });

  expect(response.status).toBe(200);
  expect(bodies).toHaveLength(2);
  expect(JSON.stringify(bodies[0])).toContain(SIGNATURE);
  expect(JSON.stringify(bodies[1])).not.toContain(SIGNATURE);
});

test("retries locally when a newer replay generation makes cache clearing stale", async () => {
  const context = logicalContext(`sha256:stale-clear-${crypto.randomUUID()}`);
  const cache = new ReasoningReplayCache();
  const previous = cache.begin(MODEL, context.session.key, "previous-request");
  cache.commit(previous, functionCallReplay());
  const inputBody = {
    contents: [{ role: "user", parts: [{ functionResponse: { id: "call-1", name: "weather", response: {} } }] }],
  };
  const bodies: unknown[] = [];
  const newerReplay = functionCallReplay(NEWER_SIGNATURE);
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    options: { baseURL: "https://example.test" },
    replayCache: cache,
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        const newer = cache.begin(MODEL, context.session.key, "newer-request");
        expect(cache.commit(newer, newerReplay)).toBe(true);
        return Response.json({ error: { message: "function call has invalid thoughtSignature" } }, { status: 400 });
      }
      return Response.json({ response: { candidates: [] } });
    },
  });

  const response = await transport.execute({
    body: inputBody,
    context,
    modelId: MODEL,
    requestType: "agent",
    stream: false,
  });

  expect(response.status).toBe(200);
  expect(bodies).toHaveLength(2);
  expect(JSON.stringify(bodies[0])).toContain(SIGNATURE);
  expect(JSON.stringify(bodies[1])).not.toContain(SIGNATURE);
  expect(bodies[1]).toMatchObject({ request: inputBody });
  expect(cache.read(previous.key)?.parts).toEqual(newerReplay.parts);
});

test("ordinary 400 responses neither clear nor retry replay", async () => {
  const cache = new ReasoningReplayCache();
  const context = logicalContext(`sha256:ordinary-${crypto.randomUUID()}`);
  const previous = cache.begin(MODEL, context.session.key, "previous-request");
  cache.commit(previous, functionCallReplay());
  let calls = 0;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    options: { baseURL: "https://example.test" },
    replayCache: cache,
    fetch: async () => {
      calls += 1;
      return Response.json({ error: { message: "invalid request" } }, { status: 400 });
    },
  });

  const response = await transport.execute({
    body: {
      contents: [{ role: "user", parts: [{ functionResponse: { id: "call-1", name: "weather", response: {} } }] }],
    },
    context,
    modelId: MODEL,
    requestType: "agent",
    stream: false,
  });

  expect(response.status).toBe(400);
  expect(calls).toBe(1);
  expect(cache.read(previous.key)?.parts).toEqual(functionCallReplay().parts);
});

function functionCallReplay(signature = SIGNATURE): ReasoningReplay {
  return {
    parts: [
      {
        type: "function-call",
        contentIndex: 0,
        partIndex: 0,
        call: { id: "call-1", name: "weather", args: {} },
        signature,
      },
    ],
  };
}

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

function logicalContext(session: `sha256:${string}`): LogicalRequestContext {
  return { requestId: crypto.randomUUID(), session: { key: session, source: "transcript" } };
}
