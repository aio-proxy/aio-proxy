import { describe, expect, test } from "bun:test";

import { definePlugin, isPluginDescriptor, PLUGIN_API_VERSION, PLUGIN_DESCRIPTOR_BRAND, zod } from "../src";

describe("definePlugin", () => {
  test("brands an apiVersion 2 descriptor", () => {
    const descriptor = definePlugin(() => {});
    expect(descriptor.apiVersion).toBe(2);
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
    expect(PLUGIN_API_VERSION).toBe(2);
  });

  test("rejects unbranded lookalikes", () => {
    expect(isPluginDescriptor({ apiVersion: 2, setup() {} })).toBe(false);
  });

  test("rejects branded descriptors without object metadata", () => {
    const descriptor = {
      [PLUGIN_DESCRIPTOR_BRAND]: true,
      apiVersion: PLUGIN_API_VERSION,
      setup() {},
    };

    expect(isPluginDescriptor(descriptor)).toBe(false);
    expect(isPluginDescriptor({ ...descriptor, metadata: null })).toBe(false);
    expect(isPluginDescriptor({ ...descriptor, metadata: [] })).toBe(false);
  });

  test("recognizes descriptor shells without validating plugin options", () => {
    const descriptor = {
      [PLUGIN_DESCRIPTOR_BRAND]: true,
      apiVersion: PLUGIN_API_VERSION,
      setup() {},
    };

    expect(isPluginDescriptor({ ...descriptor, metadata: { options: null } })).toBe(true);
    expect(isPluginDescriptor({ ...descriptor, metadata: { options: { form: "bad" } } })).toBe(true);
  });

  test("accepts branded apiVersion 1 descriptors for compatibility", () => {
    const descriptor = {
      [PLUGIN_DESCRIPTOR_BRAND]: true,
      apiVersion: 1,
      metadata: {},
      setup() {},
    };
    expect(isPluginDescriptor(descriptor)).toBe(true);
  });
});
