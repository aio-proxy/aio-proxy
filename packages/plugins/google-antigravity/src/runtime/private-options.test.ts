import { describe, expect, test } from "bun:test";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import { takeAioProxyOptions } from "./private-options";

describe("takeAioProxyOptions", () => {
  test("removes private aioProxy options and preserves provider siblings", () => {
    const context = logicalContext();

    const split = takeAioProxyOptions({
      google: { responseModalities: ["TEXT"] },
      other: { marker: true },
      aioProxy: { logicalRequest: context, thinking: { mode: "adaptive", effort: "high" } },
    });

    expect(split.context).toEqual(context);
    expect(split.privateOptions).toEqual({
      logicalRequest: context,
      thinking: { mode: "adaptive", effort: "high" },
    });
    expect(split.providerOptions).toEqual({
      google: { responseModalities: ["TEXT"] },
      other: { marker: true },
    });
  });

  test("rejects calls without a logical request context", () => {
    expect(() => takeAioProxyOptions({ google: {} })).toThrow();
  });

  test("rejects malformed private thinking options", () => {
    expect(() =>
      takeAioProxyOptions({
        aioProxy: { logicalRequest: logicalContext(), thinking: { mode: "fixed", budgetTokens: -1 } },
      }),
    ).toThrow();
  });
});

function logicalContext(): LogicalRequestContext {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    session: { key: "sha256:abc", source: "transcript" },
  };
}
