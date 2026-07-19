import { expect, spyOn, test } from "bun:test";
import { brotliCompressSync, deflateRawSync, deflateSync } from "node:zlib";

import {
  InvalidCompressedRequestBodyError,
  REQUEST_BODY_LIMITS,
  RequestBodyTooLargeError,
  readJsonRequest,
  rewriteJsonRequestModel,
  UnsupportedContentEncodingError,
} from "./request";

const jsonBytes = new TextEncoder().encode(JSON.stringify({ ok: true }));

test("rewriteJsonRequestModel preserves unknown fields and removes stale body encoding headers", async () => {
  const body = Bun.gzipSync(
    new TextEncoder().encode(JSON.stringify({ model: "client-model", beta_field: { enabled: true } })),
  );
  const rewritten = await rewriteJsonRequestModel(
    new Request("https://proxy.test/v1/responses", {
      method: "POST",
      headers: {
        "content-encoding": "gzip",
        "content-length": String(body.byteLength),
        "content-type": "application/json",
      },
      body,
    }),
    "upstream-model",
  );

  expect(rewritten.headers.get("content-encoding")).toBeNull();
  expect(rewritten.headers.get("content-length")).toBeNull();
  expect(await rewritten.json()).toEqual({
    model: "upstream-model",
    beta_field: { enabled: true },
  });
});

test.each([
  ["gzip", Bun.gzipSync(jsonBytes)],
  ["x-gzip", Bun.gzipSync(jsonBytes)],
  ["zstd", Bun.zstdCompressSync(jsonBytes)],
  ["deflate", deflateSync(jsonBytes)],
  ["deflate", deflateRawSync(jsonBytes)],
  ["br", brotliCompressSync(jsonBytes)],
] as const)("readJsonRequest decodes %s request bodies", async (encoding, body) => {
  expect(await readJsonRequest(encodedRequest(encoding, body))).toEqual({ ok: true });
});

test.each(["identity", "IDENTITY"])("readJsonRequest ignores %s", async (encoding) => {
  expect(await readJsonRequest(encodedRequest(encoding, jsonBytes))).toEqual({ ok: true });
});

test("readJsonRequest parses requests without content encoding", async () => {
  const request = new Request("https://proxy.test/v1/responses", { method: "POST", body: jsonBytes });
  expect(await readJsonRequest(request)).toEqual({ ok: true });
});

test.each(["compress", "gzip, br"])("readJsonRequest rejects unsupported coding %s", async (encoding) => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(readJsonRequest(encodedRequest(encoding, jsonBytes))).rejects.toBeInstanceOf(
      UnsupportedContentEncodingError,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain(encoding.toLowerCase());
  } finally {
    warn.mockRestore();
  }
});

test("readJsonRequest rejects unsupported coding without reading the body", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let pulls = 0;
  let releasePull = () => {};
  const request = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-encoding": "compress", "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        return new Promise<void>((resolve) => {
          releasePull = () => {
            controller.close();
            resolve();
          };
        });
      },
    }),
  });
  const parsing = readJsonRequest(request);

  try {
    const result = await settleWithin(parsing, 100);

    expect(result).toBeInstanceOf(UnsupportedContentEncodingError);
    expect(pulls).toBe(0);
    expect(request.bodyUsed).toBe(true);
  } finally {
    releasePull();
    await parsing.catch(() => undefined);
    warn.mockRestore();
  }
});

test.each(["gzip", "zstd", "deflate", "br"])("normalizes corrupt %s bodies", async (encoding) => {
  await expect(readJsonRequest(encodedRequest(encoding, new Uint8Array([1, 2, 3, 4])))).rejects.toBeInstanceOf(
    InvalidCompressedRequestBodyError,
  );
});

test("readJsonRequest limits decompressed gzip bytes", async () => {
  const body = Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ padding: "x".repeat(64) })));
  const request = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-encoding": "gzip", "content-type": "application/json" },
    body,
  });

  await expect(readJsonRequest(request, { encoded: body.byteLength, decoded: 32 })).rejects.toBeInstanceOf(
    RequestBodyTooLargeError,
  );
});

test("readJsonRequest limits decompressed zstd bytes", async () => {
  const body = Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify({ padding: "x".repeat(64) })));
  const request = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-encoding": "zstd", "content-type": "application/json" },
    body,
  });

  await expect(readJsonRequest(request, { encoded: body.byteLength, decoded: 32 })).rejects.toBeInstanceOf(
    RequestBodyTooLargeError,
  );
});

test("readJsonRequest does not raw-fallback when deflate output exceeds the limit", async () => {
  const body = deflateSync(new TextEncoder().encode(JSON.stringify({ padding: "x".repeat(64) })));
  await expect(
    readJsonRequest(encodedRequest("deflate", body), { encoded: body.byteLength, decoded: 32 }),
  ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
});

test("readJsonRequest limits encoded gzip bytes before decompression", async () => {
  const emptyMember = Bun.gzipSync(new Uint8Array());
  const body = new Uint8Array(emptyMember.byteLength * 2);
  body.set(emptyMember);
  body.set(emptyMember, emptyMember.byteLength);
  const request = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-encoding": "gzip", "content-type": "application/json" },
    body,
  });

  await expect(
    readJsonRequest(request, { encoded: emptyMember.byteLength, decoded: REQUEST_BODY_LIMITS.decoded }),
  ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
});

test("readJsonRequest rejects a chunked body before retaining bytes beyond the limit", async () => {
  const request = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        controller.enqueue(new TextEncoder().encode("true}"));
        controller.close();
      },
    }),
  });

  await expect(readJsonRequest(request, { encoded: 8, decoded: REQUEST_BODY_LIMITS.decoded })).rejects.toBeInstanceOf(
    RequestBodyTooLargeError,
  );
});

test("readJsonRequest cancels every retained branch when a chunked body exceeds the limit", async () => {
  let resolveCancellation: (reason: unknown) => void = () => {};
  const cancellation = new Promise<unknown>((resolve) => {
    resolveCancellation = resolve;
  });
  let chunks = 0;
  const request = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks < 9) {
          chunks += 1;
          controller.enqueue(new Uint8Array(1));
        }
      },
      cancel(reason) {
        resolveCancellation(reason);
      },
    }),
  });

  const result = await settleWithin(
    readJsonRequest(request, { encoded: 8, decoded: REQUEST_BODY_LIMITS.decoded }),
    1_000,
  );
  if (!request.bodyUsed) await request.body?.cancel("test cleanup");

  expect(result).toBeInstanceOf(RequestBodyTooLargeError);
  expect(await settleWithin(cancellation, 100)).not.toBeInstanceOf(TimeoutError);
  expect(request.bodyUsed).toBe(true);
});

function encodedRequest(encoding: string, body: Uint8Array): Request {
  return new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-encoding": encoding, "content-type": "application/json" },
    body,
  });
}

class TimeoutError extends Error {}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch((error: unknown) => error),
      new Promise<TimeoutError>((resolve) => {
        timeout = setTimeout(() => resolve(new TimeoutError("Timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
