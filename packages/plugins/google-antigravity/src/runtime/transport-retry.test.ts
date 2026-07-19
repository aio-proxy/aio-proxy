import { expect, test } from "bun:test";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import type { GoogleAntigravityCredential } from "../schema";
import { AntigravityUpstreamError } from "./errors";
import { AntigravityTransport, type AntigravityTransportDependencies } from "./transport";

test.each([
  ["network", true],
  ["no-capacity", true],
  ["400", false],
  ["500", false],
] as const)("switches endpoint only for approved %s classifications", async (kind, switches) => {
  const origins: string[] = [];
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async (input) => {
      const origin = new URL(String(input)).origin;
      origins.push(origin);
      if (origins.length > 1) return Response.json({ response: { ok: true } });
      if (kind === "network") throw new TypeError("socket reset");
      if (kind === "no-capacity") {
        return Response.json({ error: { message: "No capacity is available" } }, { status: 503 });
      }
      return Response.json({}, { status: Number(kind) });
    },
  });

  try {
    await transport.execute(executeInput());
  } catch (error) {
    expect(error).toBeInstanceOf(AntigravityUpstreamError);
  }
  expect(origins).toHaveLength(switches ? 2 : 1);
});

test("switches endpoint after a known connection reset", async () => {
  const origins: string[] = [];
  const reset = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async (input) => {
      origins.push(new URL(String(input)).origin);
      if (origins.length === 1) throw reset;
      return Response.json({ response: { ok: true } });
    },
  });

  await transport.execute(executeInput());

  expect(origins).toEqual(["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"]);
});

test.each([
  ["plain Error", new Error("implementation failure")],
  ["unknown object", { kind: "unknown-fetch-failure" }],
] as const)("does not switch endpoint for %s thrown by fetch", async (_label, failure) => {
  const origins: string[] = [];
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async (input) => {
      origins.push(new URL(String(input)).origin);
      throw failure;
    },
  });

  await expect(transport.execute(executeInput())).rejects.toBe(failure);
  expect(origins).toEqual(["https://daily-cloudcode-pa.googleapis.com"]);
});

test("uses at most one short 429 retry per endpoint", async () => {
  const seen: Request[] = [];
  const sleeps: number[] = [];
  const transport = fixtureTransport(
    [
      Response.json({}, { status: 429, headers: { "Retry-After": "2" } }),
      Response.json({}, { status: 429, headers: { "Retry-After": "1" } }),
      Response.json({ response: { ok: true } }),
    ],
    seen,
    { sleep: async (milliseconds) => sleeps.push(milliseconds) },
  );

  await transport.execute(executeInput());

  expect(sleeps).toEqual([2_000]);
  expect(seen.map((request) => new URL(request.url).origin)).toEqual([
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ]);
});

test.each(["2.5", "2e0", "0x2", "-1"])("does not short-retry a non-integer Retry-After value %s", async (value) => {
  const seen: Request[] = [];
  const sleeps: number[] = [];
  const transport = fixtureTransport(
    [Response.json({}, { status: 429, headers: { "Retry-After": value } }), Response.json({ response: { ok: true } })],
    seen,
    { sleep: async (milliseconds) => sleeps.push(milliseconds) },
  );

  await transport.execute(executeInput());

  expect(sleeps).toEqual([]);
  expect(seen.map((request) => new URL(request.url).origin)).toEqual([
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ]);
});

test("short-retries valid Retry-After HTTP-date variants", async () => {
  for (const retryAt of httpDateVariants(new Date(Date.now() + 1_500))) {
    const seen: Request[] = [];
    const sleeps: number[] = [];
    const transport = fixtureTransport(
      [
        Response.json({}, { status: 429, headers: { "Retry-After": retryAt } }),
        Response.json({ response: { ok: true } }),
      ],
      seen,
      { sleep: async (milliseconds) => sleeps.push(milliseconds) },
    );

    await transport.execute(executeInput());

    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(0);
    expect(sleeps[0]).toBeLessThan(3_000);
    expect(seen.map((request) => new URL(request.url).origin)).toEqual([
      "https://daily-cloudcode-pa.googleapis.com",
      "https://daily-cloudcode-pa.googleapis.com",
    ]);
  }
});

test("caller cancellation is propagated without endpoint replay", async () => {
  const abort = new AbortController();
  const reason = new DOMException("caller stopped", "AbortError");
  let requests = 0;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async () => {
      requests += 1;
      abort.abort(reason);
      throw reason;
    },
  });

  await expect(transport.execute(executeInput({ signal: abort.signal }))).rejects.toBe(reason);
  expect(requests).toBe(1);
});

test("caller cancellation interrupts an injected Retry-After sleep", async () => {
  const reason = { kind: "sleep-cancelled" };
  const abort = new AbortController();
  let releaseSleep = () => {};
  let markSleepStarted = () => {};
  const sleepStarted = new Promise<void>((resolve) => {
    markSleepStarted = resolve;
  });
  let requests = 0;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async () => {
      requests += 1;
      return Response.json({}, { status: 429, headers: { "Retry-After": "2" } });
    },
    sleep: async () =>
      await new Promise<void>((resolve) => {
        releaseSleep = resolve;
        markSleepStarted();
      }),
  });

  const execution = transport.execute(executeInput({ signal: abort.signal }));
  await sleepStarted;
  abort.abort(reason);
  const outcome = await Promise.race([
    execution.then(
      () => "resolved",
      (error: unknown) => error,
    ),
    Bun.sleep(50).then(() => "timeout"),
  ]);
  releaseSleep();
  await execution.catch(() => undefined);

  expect(outcome).toBe(reason);
  expect(requests).toBe(1);
});

function fixtureTransport(
  responses: readonly Response[],
  seen: Request[],
  overrides: Partial<AntigravityTransportDependencies>,
) {
  let index = 0;
  return new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async (input, init) => {
      seen.push(new Request(input, init));
      return responses[index++] ?? Response.json({ response: {} });
    },
    ...overrides,
  });
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

function httpDateVariants(date: Date): readonly string[] {
  const imf = date.toUTCString();
  const [weekday, day, month, year, time] = imf.replace(",", "").split(" ") as [string, string, string, string, string];
  const longWeekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getUTCDay()];
  const rfc850 = `${longWeekday}, ${day}-${month}-${year.slice(-2)} ${time} GMT`;
  const asctimeDay = String(date.getUTCDate()).padStart(2, " ");
  const asctime = `${weekday} ${month} ${asctimeDay} ${time} ${year}`;
  return [imf, rfc850, asctime];
}
