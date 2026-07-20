import { getLogger, reset } from "@logtape/logtape";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureLogging, isLoggingConfigured } from ".";
import { toLogTapeLevel } from "../levels";

afterEach(async () => {
  await reset();
});

describe("toLogTapeLevel", () => {
  test("maps SDK levels to LogTape levels", () => {
    expect(toLogTapeLevel("debug")).toBe("debug");
    expect(toLogTapeLevel("info")).toBe("info");
    expect(toLogTapeLevel("warn")).toBe("warning");
    expect(toLogTapeLevel("error")).toBe("error");
  });
});

describe("configureLogging", () => {
  test("defaults to info and configures the aio-proxy hierarchy", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined);

    expect(isLoggingConfigured()).toBe(false);
    await configureLogging({ dir: "/unused/when-disabled" });
    expect(isLoggingConfigured()).toBe(true);
    const logger = getLogger(["aio-proxy", "test"]);
    logger.debug("hidden");
    logger.info("visible");

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('"message":"visible"');
    error.mockRestore();
  });

  test("writes daily JSON lines with structured properties", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-logger-"));
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await configureLogging({ dir, enabled: true });
      getLogger(["aio-proxy", "test"]).info("written", { requestId: "request-1" });
      await reset();

      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      const records = readFileSync(join(dir, files[0]!), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ message: "written", properties: { requestId: "request-1" } });
    } finally {
      error.mockRestore();
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
