import { describe, expect, test } from "bun:test";
import { parseProviderOptions } from "../src/modules/providers/components/provider-options-textarea";

describe("parseProviderOptions", () => {
  test("Given malformed JSON When parsed Then it is rejected", () => {
    expect(parseProviderOptions("{")).toEqual({ ok: false });
  });

  test("Given a non-object JSON value When parsed Then it is rejected", () => {
    expect(parseProviderOptions("[]")).toEqual({ ok: false });
  });

  test("Given an options object When parsed Then the typed record is returned", () => {
    expect(parseProviderOptions('{"baseURL":"https://example.com"}')).toEqual({
      ok: true,
      value: { baseURL: "https://example.com" },
    });
  });
});
