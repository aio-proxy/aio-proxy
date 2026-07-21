import { describe, expect, test } from "bun:test";

import { createProxyFetch } from "./proxy-fetch";

describe("createProxyFetch", () => {
  test("forwards the proxy option to the wrapped fetch call", async () => {
    const calls: unknown[][] = [];
    const spy = (async (...args: unknown[]) => {
      calls.push(args);
      return new Response();
    }) as typeof globalThis.fetch;

    const proxyFetch = createProxyFetch("http://proxy.example:8080", spy);
    await proxyFetch("https://upstream.example/v1", { method: "POST" });

    expect(calls).toEqual([["https://upstream.example/v1", { method: "POST", proxy: "http://proxy.example:8080" }]]);
  });

  test("returns the fetch implementation unchanged when no proxy is configured", () => {
    const spy = (async () => new Response()) as typeof globalThis.fetch;

    expect(createProxyFetch(undefined, spy)).toBe(spy);
  });

  test("defaults to globalThis.fetch when no fetch implementation is injected", () => {
    expect(createProxyFetch(undefined)).toBe(globalThis.fetch);
  });
});
