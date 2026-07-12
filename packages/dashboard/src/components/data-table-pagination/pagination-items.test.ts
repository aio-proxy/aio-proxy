import { describe, expect, test } from "@rstest/core";
import { getPaginationItems } from "./pagination-items";

describe("data table pagination", () => {
  test("shows every page when the page count fits", () => {
    expect(getPaginationItems([0, 1, 2, 3, 4], 2)).toEqual([0, 1, 2, 3, 4]);
  });

  test("shows the current page and its neighbors between ellipses", () => {
    expect(
      getPaginationItems(
        Array.from({ length: 10 }, (_, index) => index),
        5,
      ),
    ).toEqual([0, "ellipsis", 4, 5, 6, "ellipsis", 9]);
  });

  test("expands the window near the beginning", () => {
    expect(
      getPaginationItems(
        Array.from({ length: 10 }, (_, index) => index),
        1,
      ),
    ).toEqual([0, 1, 2, 3, 4, "ellipsis", 9]);
  });

  test("expands the window near the end", () => {
    expect(
      getPaginationItems(
        Array.from({ length: 10 }, (_, index) => index),
        8,
      ),
    ).toEqual([0, "ellipsis", 5, 6, 7, 8, 9]);
  });

  test("supports a single page", () => {
    expect(getPaginationItems([0], 0)).toEqual([0]);
  });
});
