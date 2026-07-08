import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { aioHome, configPath, dbPath, logPath, packagesDir, pidPath } from "../src/paths";

const original = process.env.AIO_PROXY_HOME;

afterEach(() => {
  if (original === undefined) {
    delete process.env.AIO_PROXY_HOME;
  } else {
    process.env.AIO_PROXY_HOME = original;
  }
});

describe("paths", () => {
  test("AIO_PROXY_HOME override drives every derived path", () => {
    process.env.AIO_PROXY_HOME = "/tmp/foo";
    expect(aioHome()).toBe("/tmp/foo");
    expect(configPath()).toBe("/tmp/foo/config.jsonc");
    expect(dbPath()).toBe("/tmp/foo/aio-proxy.db");
    expect(packagesDir()).toBe("/tmp/foo/packages");
    expect(pidPath()).toBe("/tmp/foo/aio-proxy.pid");
    expect(logPath()).toBe("/tmp/foo/aio-proxy.log");
  });

  test("absent env falls back to ~/.aio-proxy", () => {
    delete process.env.AIO_PROXY_HOME;
    expect(aioHome()).toBe(join(homedir(), ".aio-proxy"));
    expect(aioHome().endsWith(".aio-proxy")).toBe(true);
  });

  test("empty string is treated as absent", () => {
    process.env.AIO_PROXY_HOME = "";
    expect(aioHome()).toBe(join(homedir(), ".aio-proxy"));
    expect(configPath()).toBe(join(homedir(), ".aio-proxy", "config.jsonc"));
  });

  test("derived paths end with the correct basenames", () => {
    process.env.AIO_PROXY_HOME = "/tmp/foo";
    expect(configPath().endsWith("/config.jsonc")).toBe(true);
    expect(dbPath().endsWith("/aio-proxy.db")).toBe(true);
    expect(packagesDir().endsWith("/packages")).toBe(true);
    expect(pidPath().endsWith("/aio-proxy.pid")).toBe(true);
    expect(logPath().endsWith("/aio-proxy.log")).toBe(true);
  });
});
