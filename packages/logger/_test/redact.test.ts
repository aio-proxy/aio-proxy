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

  test("redacts default Error fields that match a configured secret", () => {
    expect(redactLogValue(new Error("ok"), ["Error"])).toEqual(
      expect.objectContaining({ name: "[REDACTED]", message: "ok" }),
    );
  });

  test("redacts canonical Error output keys that match a configured secret", () => {
    const error = new Error("ok", { cause: "safe" });
    error.name = "Failure";
    error.stack = "trace";

    for (const secret of ["name", "message", "stack", "cause"]) {
      expect(JSON.stringify(redactLogValue(error, [secret]))).not.toContain(secret);
    }
  });

  test("functions yield a safe placeholder instead of passing through", () => {
    function abc() {}

    expect(redactLogValue(abc, ["abc"])).toEqual({ message: "log redaction failed" });
    expect(redactLogValue(abc, [])).toEqual({ message: "log redaction failed" });
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

  test("re-scans marker insertions that synthesize another configured secret", () => {
    expect(redactLogText("Ax", ["A[R", "x"])).not.toContain("A[R");
  });

  test("redacts Map and Set branches while preserving safe siblings", () => {
    const output = redactLogValue(
      {
        safe: "visible",
        map: new Map([["token", "abc"]]),
        set: new Set(["abc"]),
      },
      ["abc"],
    );

    expect(output).toEqual({
      safe: "visible",
      map: [["token", "[REDACTED]"]],
      set: ["[REDACTED]"],
    });
  });
});
