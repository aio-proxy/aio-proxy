import { describe, expect, test } from "bun:test";
import { LocalizedTextSchema, resolveLocalizedText } from "../src";

describe("LocalizedText", () => {
  test("resolves strings, exact locales, base languages, and invalid host locales", () => {
    expect(resolveLocalizedText("Plain", "zh-Hans")).toBe("Plain");
    expect(resolveLocalizedText({ default: "Default", "zh-Hans": "中文" }, "zh-Hans")).toBe("中文");
    expect(resolveLocalizedText({ default: "Default", en: "English" }, "en-US")).toBe("English");
    expect(resolveLocalizedText({ default: "Default" }, "broken_locale")).toBe("Default");
  });

  test("validates canonical JSON locale maps and clones them to plain data", () => {
    const parsed = LocalizedTextSchema.parse({ default: "Default", en: "English", "zh-Hans": "中文" });
    expect(parsed).toEqual({ default: "Default", en: "English", "zh-Hans": "中文" });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  test.each([
    [{ en: "English" }, "missing default"],
    [{ default: "" }, "empty default"],
    [{ default: "Default", en: " " }, "empty locale value"],
    [{ default: "Default", "en-us": "English" }, "non-canonical locale"],
    [{ default: "Default", broken_locale: "Broken" }, "invalid locale"],
  ])("rejects %s (%s)", (value) => {
    expect(LocalizedTextSchema.safeParse(value).success).toBe(false);
  });

  test("rejects accessors, symbols, and cycles without invoking accessors", () => {
    let reads = 0;
    const accessor = { default: "Default" };
    Object.defineProperty(accessor, "en", {
      enumerable: true,
      get() {
        reads += 1;
        return "English";
      },
    });
    expect(LocalizedTextSchema.safeParse(accessor).success).toBe(false);
    expect(reads).toBe(0);

    const symbol = { default: "Default", [Symbol("copy")]: "hidden" };
    expect(LocalizedTextSchema.safeParse(symbol).success).toBe(false);

    const cyclic: Record<string, unknown> = { default: "Default" };
    Object.assign(cyclic, { en: cyclic });
    expect(LocalizedTextSchema.safeParse(cyclic).success).toBe(false);
  });

  test("materializes a stateful proxy exactly once", () => {
    let ownKeysCalls = 0;
    const source = { default: "Default", en: "English" };
    const proxy = new Proxy(source, {
      ownKeys(target) {
        ownKeysCalls += 1;
        if (ownKeysCalls > 1) throw new Error("second materialization");
        return Reflect.ownKeys(target);
      },
    });

    const parsed = LocalizedTextSchema.safeParse(proxy);

    expect(parsed).toEqual({ success: true, data: source });
    expect(parsed.success && parsed.data).not.toBe(source);
    expect(ownKeysCalls).toBe(1);
  });

  test.each(["getPrototypeOf", "ownKeys"] as const)("contains throwing %s traps", (trap) => {
    const proxy = new Proxy(
      { default: "Default" },
      {
        [trap]() {
          throw new Error("plugin reflection failure");
        },
      },
    );

    expect(() => LocalizedTextSchema.safeParse(proxy)).not.toThrow();
    expect(LocalizedTextSchema.safeParse(proxy).success).toBe(false);
  });
});
