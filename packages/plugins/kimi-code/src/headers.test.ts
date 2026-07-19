import { expect, test } from "bun:test";
import { kimiIdentityHeaders } from "./headers";

test("builds stable printable Kimi identity headers around the credential device ID", () => {
  const headers = kimiIdentityHeaders("device-1", {
    hostname: () => "主机 name",
    platform: () => "darwin",
    release: () => "26.0",
    arch: () => "arm64",
    version: () => "Darwin 25.0 主机",
  });
  expect(headers).toMatchObject({
    "User-Agent": "AIO-Proxy/0.0.0",
    "X-Msh-Platform": "AIO-Proxy",
    "X-Msh-Device-Id": "device-1",
    "X-Msh-Device-Name": "name",
    "X-Msh-Device-Model": "macOS 26.0 arm64",
    "X-Msh-Os-Version": "Darwin 25.0",
  });
  expect(Object.values(headers).every((value) => /^[\x20-\x7e]+$/u.test(value))).toBe(true);
});
