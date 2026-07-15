import { afterEach, expect } from "@rstest/core";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";

expect.extend(jestDomMatchers);

if (Element.prototype.getAnimations === undefined) {
  Element.prototype.getAnimations = () => [];
}

afterEach(cleanup);
