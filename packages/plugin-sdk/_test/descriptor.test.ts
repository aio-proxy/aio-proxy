import { describe, expect, test } from "bun:test";
import { definePlugin, isPluginDescriptor, PLUGIN_API_VERSION, PLUGIN_DESCRIPTOR_BRAND, zod } from "../src";

describe("definePlugin", () => {
  test("brands an apiVersion 1 descriptor", () => {
    const descriptor = definePlugin(() => {});
    expect(descriptor.apiVersion).toBe(1);
    expect(descriptor[PLUGIN_DESCRIPTOR_BRAND]).toBe(true);
    expect(isPluginDescriptor(descriptor)).toBe(true);
  });

  test("retains a plugin ConfigSpec without executing setup", () => {
    let calls = 0;
    const options = { schema: zod.object({ baseURL: zod.url() }), form: [] } as const;
    const descriptor = definePlugin(
      () => {
        calls += 1;
      },
      { options },
    );

    expect(descriptor.metadata.options).toBe(options);
    expect(calls).toBe(0);
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  test("rejects unbranded lookalikes", () => {
    expect(isPluginDescriptor({ apiVersion: 1, setup() {} })).toBe(false);
  });
});
