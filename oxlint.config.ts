import { defineConfig } from "oxlint";

import { ignorePatterns } from "./oxc.ts";

export default defineConfig({
  categories: {
    correctness: "error",
  },

  rules: {
    "typescript/no-deprecated": "error",
    "max-lines": [
      "warn",
      {
        max: 300,
        skipBlankLines: true,
        skipComments: false,
      },
    ],
  },
  ignorePatterns,
});
