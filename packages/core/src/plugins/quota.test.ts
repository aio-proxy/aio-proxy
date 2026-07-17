import { describe, expect, test } from "bun:test";
import { OAuthQuotaValidationError, validateOAuthQuotaSnapshot } from "./quota";

const validSnapshot = () => ({
  items: [
    {
      id: "five-hour",
      label: { default: "5 hour", "zh-Hans": "5 小时" },
      remainingRatio: 0.25,
      resetsAt: 1_800_000_000_000,
    },
    { id: "weekly", label: "Weekly", remainingRatio: 1 },
  ],
  resetCredits: {
    availableCount: 2,
    items: [{ id: "credit-a", expiresAt: 1_900_000_000_000 }],
  },
});

function expectInvalid(value: unknown, path: readonly (string | number)[]): void {
  try {
    validateOAuthQuotaSnapshot(value);
    throw new Error("Expected quota validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthQuotaValidationError);
    expect((error as OAuthQuotaValidationError).path).toEqual(path);
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("value");
  }
}

describe("validateOAuthQuotaSnapshot", () => {
  test("returns a plain deep copy while preserving item order", () => {
    const input = validSnapshot();
    const result = validateOAuthQuotaSnapshot(input);

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result.items).not.toBe(input.items);
    expect(result.items[0]).not.toBe(input.items[0]);
    expect(result.items[0]?.label).not.toBe(input.items[0]?.label);
    expect(result.resetCredits).not.toBe(input.resetCredits);
    expect(result.resetCredits?.items).not.toBe(input.resetCredits.items);
    expect(result.resetCredits?.items?.[0]).not.toBe(input.resetCredits.items[0]);
    expect(result.items.map(({ id }) => id)).toEqual(["five-hour", "weekly"]);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.items)).toBe(Array.prototype);
    expect(Object.getPrototypeOf(result.items[0])).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.items[0]?.label)).toBe(Object.prototype);
  });

  test("accepts ratio bounds, omission, and reset count independent of inventory length", () => {
    const result = validateOAuthQuotaSnapshot({
      items: [
        { id: "empty", label: "Empty", remainingRatio: 0 },
        { id: "full", label: "Full", remainingRatio: 1 },
        { id: "unknown", label: "Unknown" },
      ],
      resetCredits: { availableCount: 7, items: [{ id: "empty" }] },
    });

    expect(result.items.map(({ remainingRatio }) => remainingRatio)).toEqual([0, 1, undefined]);
    expect(result.resetCredits?.availableCount).toBe(7);
  });

  test("cleans up item record ancestors before checking duplicate IDs", () => {
    const item = { id: "same", label: "Shared" };
    expectInvalid({ items: [item, item] }, ["items", 1, "id"]);
  });

  test("cleans up array ancestors between root and reset-credit items", () => {
    const items: [] = [];
    const input = { items, resetCredits: { availableCount: 0, items } };

    expect(validateOAuthQuotaSnapshot(input)).toEqual(input);
  });

  test("preserves nonblank item IDs including surrounding whitespace", () => {
    const result = validateOAuthQuotaSnapshot({ items: [{ id: "  unchanged  ", label: "Whitespace" }] });
    expect(result.items[0]?.id).toBe("  unchanged  ");
  });

  test("uses the fixed quota validation error name and message", () => {
    const error = new OAuthQuotaValidationError([]);
    expect(error.name).toBe("OAuthQuotaValidationError");
    expect(error.message).toBe("Plugin quota snapshot is invalid");
  });

  test.each([
    ["blank item ID", { items: [{ id: " ", label: "Blank" }] }, ["items", 0, "id"]],
    [
      "duplicate item ID",
      {
        items: [
          { id: "same", label: "One" },
          { id: "same", label: "Two" },
        ],
      },
      ["items", 1, "id"],
    ],
    [
      "blank credit ID",
      { items: [], resetCredits: { availableCount: 1, items: [{ id: "", expiresAt: 1 }] } },
      ["resetCredits", "items", 0, "id"],
    ],
    [
      "duplicate credit ID",
      { items: [], resetCredits: { availableCount: 2, items: [{ id: "same" }, { id: "same" }] } },
      ["resetCredits", "items", 1, "id"],
    ],
  ] as const)("rejects %s", (_name, value, path) => {
    expectInvalid(value, path);
  });

  test.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0.01,
    1.01,
  ])("rejects invalid ratio %p", (remainingRatio) => {
    expectInvalid({ items: [{ id: "ratio", label: "Ratio", remainingRatio }] }, ["items", 0, "remainingRatio"]);
  });

  test.each([
    [new Date(), ["items", 0, "resetsAt"]],
    [Number.MAX_SAFE_INTEGER + 1, ["items", 0, "resetsAt"]],
    [1.5, ["items", 0, "resetsAt"]],
  ] as const)("rejects invalid item timestamp %p", (resetsAt, path) => {
    expectInvalid({ items: [{ id: "time", label: "Time", resetsAt }] }, path);
  });

  test.each([new Date(), Number.MAX_SAFE_INTEGER + 1, 1.5])("rejects invalid credit timestamp %p", (expiresAt) => {
    expectInvalid({ items: [], resetCredits: { availableCount: 1, items: [{ id: "credit", expiresAt }] } }, [
      "resetCredits",
      "items",
      0,
      "expiresAt",
    ]);
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid reset count %p", (availableCount) => {
    expectInvalid({ items: [], resetCredits: { availableCount } }, ["resetCredits", "availableCount"]);
  });

  test.each([
    ["blank string", ""],
    ["missing default", { "zh-Hans": "标签" }],
    ["non-canonical locale", { default: "Label", "en-us": "Label" }],
  ] as const)("rejects invalid localized text: %s", (_name, label) => {
    expectInvalid({ items: [{ id: "label", label }] }, ["items", 0, "label"]);
  });

  test.each([
    ["snapshot", { items: [], extra: true }, ["extra"]],
    ["item", { items: [{ id: "item", label: "Item", extra: true }] }, ["items", 0, "extra"]],
    ["reset inventory", { items: [], resetCredits: { availableCount: 0, extra: true } }, ["resetCredits", "extra"]],
    [
      "credit",
      { items: [], resetCredits: { availableCount: 1, items: [{ id: "credit", extra: true }] } },
      ["resetCredits", "items", 0, "extra"],
    ],
  ] as const)("rejects unknown %s fields", (_name, value, path) => {
    expectInvalid(value, path);
  });

  test("rejects accessors without invoking them", () => {
    let reads = 0;
    const input = Object.defineProperty({}, "items", {
      enumerable: true,
      get() {
        reads += 1;
        return [];
      },
    });

    expectInvalid(input, ["items"]);
    expect(reads).toBe(0);
  });

  test("rejects symbol keys", () => {
    const input = { items: [] } as Record<PropertyKey, unknown>;
    input[Symbol("secret")] = true;
    expectInvalid(input, []);
  });

  test("rejects sparse arrays and extra array properties", () => {
    const sparse = new Array(1);
    expectInvalid({ items: sparse }, ["items", 0]);

    const extra = [] as unknown[] & { note?: string };
    extra.note = "unexpected";
    expectInvalid({ items: extra }, ["items", "note"]);
  });

  test("rejects custom prototypes", () => {
    const input = Object.assign(Object.create({ inherited: true }), { items: [] });
    expectInvalid(input, []);
  });

  test("rejects active cycles", () => {
    const input: { items: unknown[] } = { items: [] };
    input.items.push(input);
    expectInvalid(input, ["items", 0]);
  });

  test("rejects proxies without invoking their traps", () => {
    let trapCalls = 0;
    const input = new Proxy(
      { items: [] },
      {
        getPrototypeOf() {
          trapCalls += 1;
          return Object.prototype;
        },
        ownKeys() {
          trapCalls += 1;
          return ["items"];
        },
        getOwnPropertyDescriptor(target, key) {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    expectInvalid(input, []);
    expect(trapCalls).toBe(0);
  });
});
