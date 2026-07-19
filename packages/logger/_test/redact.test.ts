import { describe, expect, test } from "bun:test";

import { redactLogText, redactLogValue } from "../src/redact";

describe("redactLogValue", () => {
  test("redacts secret strings in plain objects", () => {
    expect(redactLogValue({ token: "abc" }, ["abc"])).toEqual({ token: "[REDACTED]" });
  });

  test("redacts secret strings in property names", () => {
    expect(redactLogValue({ "token-abc": true }, ["abc"])).toEqual({ "token-[REDACTED]": true });
  });

  test("redacts Error message and stack without throwing", () => {
    const error = new Error("boom abc");
    error.stack = "Error: boom abc\n    at x";

    const output = redactLogValue(error, ["abc"]) as { message: string; stack?: string };

    expect(output.message.includes("abc")).toBe(false);
    expect(output.stack?.includes("abc")).toBe(false);
  });

  test("circular objects do not throw and do not leak secrets", () => {
    const input: Record<string, unknown> = { token: "abc" };
    input.self = input;

    expect(() => redactLogValue(input, ["abc"])).not.toThrow();
    expect(JSON.stringify(redactLogValue(input, ["abc"]))).not.toContain("abc");
  });

  test("redaction failure yields a safe placeholder rather than raw input", () => {
    const input = Object.defineProperty({}, "secret", {
      enumerable: true,
      get(): never {
        throw new Error("abc");
      },
    });

    expect(redactLogValue(input, ["abc"])).toEqual({ message: "log redaction failed" });
  });

  test("unsupported objects yield a safe placeholder rather than raw input", () => {
    const input = Object.assign(new Date(0), { token: "abc" });

    expect(redactLogValue(input, ["abc"])).toEqual({ message: "log redaction failed" });
  });

  test("shared references are redacted without being mistaken for cycles", () => {
    const shared = { token: "abc" };

    expect(redactLogValue({ first: shared, second: shared }, ["abc"])).toEqual({
      first: { token: "[REDACTED]" },
      second: { token: "[REDACTED]" },
    });
  });

  test("generated placeholders never reproduce configured secrets", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const throwing = Object.defineProperty({}, "value", {
      enumerable: true,
      get(): never {
        throw new Error("unreachable");
      },
    });

    expect(redactLogText("REDACTED", ["REDACTED"])).not.toContain("REDACTED");
    expect(JSON.stringify(redactLogValue(circular, ["Circular"]))).not.toContain("Circular");
    expect(JSON.stringify(redactLogValue(throwing, ["log"]))).not.toContain("log");
  });
});
