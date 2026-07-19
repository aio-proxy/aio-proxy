import { getLogger, reset } from "@logtape/logtape";
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { configureLogging, toLogTapeLevel } from "../src";

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
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    const debug = spyOn(console, "debug").mockImplementation(() => undefined);

    await configureLogging({ dir: "/unused/when-disabled" });
    const logger = getLogger(["aio-proxy", "test"]);
    logger.debug("hidden");
    logger.info("visible");

    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
    info.mockRestore();
    debug.mockRestore();
  });
});
