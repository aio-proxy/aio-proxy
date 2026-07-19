import { expect, test } from "bun:test";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import type { GoogleAntigravityCredential } from "../schema";
import { AntigravityTransport, type AntigravityTransportDependencies } from "./transport";

test("reuses identity across short retry, endpoint fallback, and one forced refresh", async () => {
  const seen: Request[] = [];
  const sleeps: number[] = [];
  const fixture = fixtureTransport(
    [
      Response.json({}, { status: 429, headers: { "Retry-After": "1" } }),
      Response.json({ error: { message: "no capacity" } }, { status: 503 }),
      Response.json({}, { status: 401 }),
      Response.json({ response: { candidates: [] } }),
    ],
    seen,
    { sleep: async (milliseconds) => sleeps.push(milliseconds) },
  );

  const response = await fixture.transport.execute(executeInput());

  expect(response.status).toBe(200);
  expect(fixture.refreshes()).toBe(1);
  expect(sleeps).toEqual([1_000]);
  expect(new Set(await Promise.all(seen.map(identityTuple))).size).toBe(1);
  expect(seen.map((request) => new URL(request.url).origin)).toEqual([
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ]);
});

test("forces refresh once and returns a second authorization failure", async () => {
  const fixture = fixtureTransport([Response.json({}, { status: 403 }), Response.json({}, { status: 401 })], []);

  const response = await fixture.transport.execute(executeInput());

  expect(response.status).toBe(401);
  expect(fixture.refreshes()).toBe(1);
});

test("uses only the outbound header whitelist", async () => {
  let seen: Request | undefined;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async (input, init) => {
      seen = new Request(input, init);
      return Response.json({ response: {} });
    },
  });

  await transport.execute(executeInput());

  expect(seen?.headers.get("authorization")).toBe("Bearer access-1");
  expect(seen?.headers.get("content-type")).toBe("application/json");
  expect(seen?.headers.get("accept")).toBe("application/json");
  expect(seen?.headers.get("user-agent")).toMatch(/^antigravity\/hub\//u);
  for (const forbidden of ["cookie", "x-client-request-id", "x-stainless-runtime", "sec-ch-ua"]) {
    expect(seen?.headers.has(forbidden)).toBe(false);
  }
});

test("shares replay across Antigravity transport instances without a Provider ID key", async () => {
  const modelId = `claude-replay-${crypto.randomUUID()}`;
  const sessionKey = `sha256:${crypto.randomUUID()}` as const;
  const signature = "shared-signature-".repeat(4);
  const first = new AntigravityTransport({
    credentials: credentialSource(),
    options: { baseURL: "https://first-provider.test" },
    fetch: async () =>
      Response.json({
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { id: "call-1", name: "weather", args: {} }, thoughtSignature: signature }],
              },
              finishReason: "STOP",
            },
          ],
        },
      }),
  });
  await first.execute(
    executeInput({ modelId, context: logicalContext({ requestId: crypto.randomUUID(), sessionKey }) }),
  );

  let fallbackBody = "";
  const fallback = new AntigravityTransport({
    credentials: credentialSource(),
    options: { baseURL: "https://fallback-provider.test" },
    fetch: async (_input, init) => {
      fallbackBody = String(init?.body);
      return Response.json({ response: { candidates: [] } });
    },
  });
  await fallback.execute(
    executeInput({
      body: {
        contents: [{ role: "user", parts: [{ functionResponse: { id: "call-1", name: "weather", response: {} } }] }],
      },
      modelId,
      context: logicalContext({ requestId: crypto.randomUUID(), sessionKey }),
    }),
  );

  expect(fallbackBody).toContain(signature);
});

function fixtureTransport(
  responses: Array<Response | Error>,
  seen: Request[],
  overrides: Partial<AntigravityTransportDependencies> = {},
) {
  let index = 0;
  let refreshCount = 0;
  const transport = new AntigravityTransport({
    credentials: {
      current: async () => credentialFixture(),
      forceRefresh: async () => {
        refreshCount += 1;
        return credentialFixture({ accessToken: "access-2" });
      },
    },
    fetch: async (input, init) => {
      seen.push(new Request(input, init));
      const scripted = responses[index++];
      if (scripted instanceof Error) throw scripted;
      return scripted ?? Response.json({ response: {} });
    },
    ...overrides,
  });
  return { transport, refreshes: () => refreshCount };
}

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

async function identityTuple(request: Request): Promise<string> {
  const body = (await request.clone().json()) as {
    readonly requestId: string;
    readonly request: { readonly sessionId: string };
  };
  return `${body.requestId}:${body.request.sessionId}:${await request.clone().text()}`;
}

function credentialSource() {
  return { current: async () => credentialFixture(), forceRefresh: async () => credentialFixture() };
}

function credentialFixture(overrides: Partial<GoogleAntigravityCredential> = {}): GoogleAntigravityCredential {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1_900_000_000_000,
    email: "person@example.com",
    projectId: "project-1",
    ...overrides,
  };
}

function logicalContext(
  overrides: { readonly requestId?: string; readonly sessionKey?: `sha256:${string}` } = {},
): LogicalRequestContext {
  return {
    requestId: overrides.requestId ?? "00000000-0000-4000-8000-000000000001",
    session: { key: overrides.sessionKey ?? "sha256:abc", source: "transcript" },
  };
}
