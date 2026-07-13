import { expect, test } from "bun:test";
import { ConfigSchema } from "../src/index";

test.each(["0.0.0.0", "192.168.1.20", "example.test"])("rejects non-loopback host %s", (host) => {
  expect(() => ConfigSchema.parse({ server: { host }, providers: {} })).toThrow();
});

test.each(["127.0.0.1", "::1", "localhost"])("accepts loopback host %s", (host) => {
  expect(ConfigSchema.parse({ server: { host }, providers: {} }).server.host).toBe(host);
});
