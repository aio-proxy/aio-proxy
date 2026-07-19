import { expect, test } from "bun:test";
import { repairGroundingSse, repairGroundingUrls } from "./grounding-urls";

const redirectUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/search-1";
const finalUrl = "https://example.com/final-source";

test.each([
  "http://127.0.0.1/private",
  "http://169.254.169.254/latest/meta-data",
])("repairs deduplicated grounding URLs with one manual HEAD without fetching %s", async (location) => {
  const payload = groundedPayload([redirectUrl, redirectUrl]);
  const requests: string[] = [];
  const methods: (string | undefined)[] = [];
  const redirectModes: (RequestRedirect | undefined)[] = [];
  let cancellations = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    methods.push(init?.method);
    redirectModes.push(init?.redirect);
    if (url !== redirectUrl) return responseAt(url);
    if (init?.redirect === "follow") return await fetch(location, init);
    const body = new ReadableStream({
      cancel() {
        cancellations += 1;
      },
    });
    return new Response(body, { status: 302, headers: { Location: location } });
  };

  const repaired = await repairGroundingUrls(payload, { fetch });

  expect(requests).toEqual([redirectUrl]);
  expect(methods).toEqual(["HEAD"]);
  expect(redirectModes).toEqual(["manual"]);
  expect(cancellations).toBe(1);
  expect(groundingUris(repaired)).toEqual([location, location]);
  expect(groundingUris(payload)).toEqual([redirectUrl, redirectUrl]);
});

test("resolves a relative redirect Location without fetching it", async () => {
  const payload = groundedPayload([redirectUrl]);

  const repaired = await repairGroundingUrls(payload, {
    fetch: async () => redirectResponse("../source"),
  });

  expect(groundingUris(repaired)).toEqual(["https://vertexaisearch.cloud.google.com/source"]);
});

test.each(["http://[::1", "file:///etc/passwd"])("preserves the payload for invalid Location %s", async (location) => {
  const payload = groundedPayload([redirectUrl]);

  const repaired = await repairGroundingUrls(payload, {
    fetch: async () => redirectResponse(location),
  });

  expect(repaired).toBe(payload);
});

test("preserves the payload when a non-redirect 304 includes a Location", async () => {
  const payload = groundedPayload([redirectUrl]);

  const repaired = await repairGroundingUrls(payload, {
    fetch: async () => redirectResponse(finalUrl, 304),
  });

  expect(repaired).toBe(payload);
});

test.each([
  ["network failure", async () => Promise.reject(new TypeError("offline"))],
  ["non-2xx response", async () => responseAt(finalUrl, 503)],
] as const)("preserves the original payload after %s", async (_label, fetch) => {
  const payload = groundedPayload([redirectUrl]);

  expect(await repairGroundingUrls(payload, { fetch })).toBe(payload);
});

test("preserves the original payload after the repair timeout aborts", async () => {
  const payload = groundedPayload([redirectUrl]);
  const timeout = new AbortController();
  timeout.abort(new DOMException("timed out", "TimeoutError"));

  const repaired = await repairGroundingUrls(payload, {
    fetch: async (_input, init) => {
      const signal = init?.signal;
      if (signal?.aborted === true) throw signal.reason;
      throw new Error("expected an aborted signal");
    },
    timeoutSignal: () => timeout.signal,
  });

  expect(repaired).toBe(payload);
});

test("propagates the exact caller abort reason", async () => {
  const payload = groundedPayload([redirectUrl]);
  const caller = new AbortController();
  const reason = { kind: "caller-abort" };
  caller.abort(reason);

  await expect(
    repairGroundingUrls(payload, {
      fetch: async (_input, init) => {
        const signal = init?.signal;
        if (signal?.aborted === true) throw signal.reason;
        throw new Error("expected an aborted signal");
      },
      signal: caller.signal,
    }),
  ).rejects.toBe(reason);
});

test("does not fetch or rewrite unrelated URLs", async () => {
  const unrelated = "https://example.com/grounding-api-redirect/search-1";
  const payload = groundedPayload([unrelated]);

  const repaired = await repairGroundingUrls(payload, {
    fetch: async () => {
      throw new Error("unrelated URLs must not be fetched");
    },
  });

  expect(repaired).toBe(payload);
});

test("repairs grounding URLs only in terminal SSE chunks", async () => {
  const nonTerminal = groundedPayload([redirectUrl]);
  const terminal = groundedPayload([redirectUrl], "STOP");
  let calls = 0;
  const stream = new Blob([
    `data: ${JSON.stringify(nonTerminal)}\n\n`,
    `data: ${JSON.stringify(terminal)}\n\n`,
    `data: ${JSON.stringify(terminal)}\n\n`,
  ]).stream();

  const repaired = repairGroundingSse(stream, {
    fetch: async () => {
      calls += 1;
      return redirectResponse(finalUrl);
    },
  });
  const text = await new Response(repaired).text();
  const payloads = text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /u, "")) as unknown);

  expect(groundingUris(payloads[0])).toEqual([redirectUrl]);
  expect(groundingUris(payloads[1])).toEqual([finalUrl]);
  expect(groundingUris(payloads[2])).toEqual([finalUrl]);
  expect(calls).toBe(1);
});

test("emits an ordinary frame before repairing a terminal frame from the same upstream chunk", async () => {
  const ordinaryFrame = `data: ${JSON.stringify(groundedPayload([]))}\n\n`;
  const terminalFrame = `data: ${JSON.stringify(groundedPayload([redirectUrl], "STOP"))}\n\n`;
  let resolveHead: ((response: Response) => void) | undefined;
  let markHeadStarted: (() => void) | undefined;
  const headStarted = new Promise<void>((resolve) => {
    markHeadStarted = resolve;
  });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(ordinaryFrame + terminalFrame));
      controller.close();
    },
  });
  const reader = repairGroundingSse(source, {
    fetch: async () => {
      markHeadStarted?.();
      return await new Promise<Response>((resolve) => {
        resolveHead = resolve;
      });
    },
  }).getReader();

  const firstRead = reader.read();
  expect(await Promise.race([firstRead.then(() => "read" as const), headStarted.then(() => "head" as const)])).toBe(
    "read",
  );
  expect(new TextDecoder().decode((await firstRead).value)).toBe(ordinaryFrame);

  const secondRead = reader.read();
  await headStarted;
  let secondSettled = false;
  void secondRead.then(() => {
    secondSettled = true;
  });
  await Promise.resolve();
  expect(secondSettled).toBe(false);

  resolveHead?.(redirectResponse(finalUrl));
  const second = await secondRead;
  expect(new TextDecoder().decode(second.value)).toContain(finalUrl);
});

function groundedPayload(uris: readonly string[], finishReason?: string) {
  return {
    candidates: [
      {
        ...(finishReason === undefined ? {} : { finishReason }),
        groundingMetadata: {
          groundingChunks: uris.map((uri) => ({ web: { uri, title: "Source" } })),
        },
      },
    ],
    unrelated: redirectUrl,
  };
}

function groundingUris(payload: unknown): string[] {
  const candidates = (payload as { candidates?: { groundingMetadata?: { groundingChunks?: unknown[] } }[] }).candidates;
  return (candidates?.[0]?.groundingMetadata?.groundingChunks ?? []).map(
    (chunk) => (chunk as { web: { uri: string } }).web.uri,
  );
}

function responseAt(url: string, status = 200): Response {
  const response = new Response(null, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}
