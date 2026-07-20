import { configure, reset, type LogRecord } from "@logtape/logtape";
import { afterEach, describe, expect, test } from "bun:test";

import { createLogger } from ".";

const records: LogRecord[] = [];

afterEach(async () => {
  records.length = 0;
  await reset();
});

async function captureLogs(): Promise<void> {
  await configure({
    sinks: { memory: records.push.bind(records) },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
      { category: ["aio-proxy"], lowestLevel: "debug", sinks: ["memory"] },
    ],
  });
}

describe("createLogger", () => {
  test("supports properties-first messages", async () => {
    await captureLogs();

    createLogger(["aio-proxy", "test"]).info({ a: 1 }, "hello");

    expect(records).toHaveLength(1);
    expect(records[0]?.properties).toMatchObject({ a: 1 });
    expect(records[0]?.message).toEqual(["hello"]);
  });

  test("supports placeholder messages", async () => {
    await captureLogs();

    createLogger(["aio-proxy", "test"]).info("hello {a}", { a: 1 });

    expect(records).toHaveLength(1);
    expect(records[0]?.properties).toMatchObject({ a: 1 });
    expect(JSON.stringify(records[0]?.message)).toContain("hello");
  });

  test("maps warn to LogTape warning", async () => {
    await captureLogs();

    createLogger(["aio-proxy", "test"]).warn("careful");

    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("warning");
  });

  test("redacts configured secret values", async () => {
    await captureLogs();

    createLogger(["aio-proxy", "test"], { redactSecretValues: ["sekrit"] }).info({ token: "sekrit" }, "token");

    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).not.toContain("sekrit");
  });

  test("uses a safe placeholder when properties cannot be inspected", async () => {
    await captureLogs();
    const properties = Object.defineProperty({}, "token", {
      enumerable: true,
      get(): never {
        throw new Error("sekrit");
      },
    });

    expect(() =>
      createLogger(["aio-proxy", "test"], { redactSecretValues: ["sekrit"] }).info(properties),
    ).not.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0]?.properties).toMatchObject({ message: "log redaction failed" });
    expect(JSON.stringify(records[0])).not.toContain("sekrit");
  });

  test("safe placeholder does not reproduce a configured secret", async () => {
    await captureLogs();
    const properties = Object.defineProperty({}, "token", {
      enumerable: true,
      get(): never {
        throw new Error("unreachable");
      },
    });

    createLogger(["aio-proxy", "test"], { redactSecretValues: ["log"] }).info(properties);

    expect(JSON.stringify(records[0])).not.toContain("log");
  });

  test("sanitizes unsafe properties when no secrets are configured", async () => {
    await captureLogs();
    const throwing = Object.defineProperty({}, "value", {
      enumerable: true,
      get(): never {
        throw new Error("getter ran");
      },
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => createLogger(["aio-proxy", "test"]).info(throwing)).not.toThrow();
    createLogger(["aio-proxy", "test"]).info({ circular });

    expect(records[0]?.properties).toEqual({ message: "log redaction failed" });
    expect(records[1]?.properties).toEqual({ circular: { self: "[Circular]" } });
  });

  test("child loggers merge bindings", async () => {
    await captureLogs();

    createLogger(["aio-proxy", "test"], { bindings: { service: "api" } })
      .child({ requestId: "req-1" })
      .info("hello");

    expect(records[0]?.properties).toMatchObject({ service: "api", requestId: "req-1" });
  });
});
