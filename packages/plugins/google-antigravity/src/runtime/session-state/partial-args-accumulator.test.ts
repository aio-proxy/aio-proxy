import { expect, test } from "bun:test";
import { PartialArgsAccumulator } from "./partial-args-accumulator";

test("assembles nested arrays, objects, primitives, and string continuations", () => {
  const accumulator = new PartialArgsAccumulator();

  expect(
    accumulator.append([
      { jsonPath: "$.items[0].city", stringValue: "Par", willContinue: true },
      { jsonPath: "$.items[0].city", stringValue: "is" },
      { jsonPath: "$.items[0].enabled", boolValue: false },
      { jsonPath: "$.items[1].count", numberValue: 0 },
      { jsonPath: "$.metadata.value", nullValue: null },
    ]),
  ).toBe(true);
  expect(accumulator.value()).toEqual({
    items: [{ city: "Paris", enabled: false }, { count: 0 }],
    metadata: { value: null },
  });
});

test("rejects a nested continuation through an existing primitive", () => {
  const accumulator = new PartialArgsAccumulator();

  expect(accumulator.append([{ jsonPath: "$.city", stringValue: "Paris" }])).toBe(true);
  expect(accumulator.append([{ jsonPath: "$.city.name", stringValue: "invalid" }])).toBe(false);
});
