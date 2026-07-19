import { expect, test } from "bun:test";
import { serverErrorType } from "./server-log";

test("serverErrorType ignores constructor data on arbitrary thrown objects", () => {
  expect(serverErrorType({ constructor: { name: "secret-marker" } })).toBe("Object");
});

test("serverErrorType contains hostile constructor access", () => {
  const thrown = Object.create(null, {
    constructor: {
      get() {
        throw new Error("secret-marker");
      },
    },
  });

  expect(serverErrorType(thrown)).toBe("Object");
});
