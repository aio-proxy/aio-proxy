import { describe, expect, test } from "bun:test";
import { getLocaleName } from "../src/locale-name";

describe("locale names", () => {
  test("uses each locale's autonym", () => {
    expect(getLocaleName("en")).toBe("English");
    expect(getLocaleName("zh-Hans")).toBe("简体中文");
  });
});
