import { defineConfig } from "oxfmt";

import { ignorePatterns } from "./oxc.ts";

export default defineConfig({
  printWidth: 120,
  tabWidth: 2,
  useTabs: false,
  singleQuote: false,
  jsxSingleQuote: false,
  quoteProps: "as-needed",
  trailingComma: "all",
  semi: true,
  arrowParens: "always",
  bracketSameLine: false,
  bracketSpacing: true,
  sortImports: {
    groups: [
      "type-import",
      ["value-builtin", "value-external"],
      "type-internal",
      "value-internal",
      ["type-parent", "type-sibling", "type-index"],
      ["value-parent", "value-sibling", "value-index"],
      "unknown",
    ],
  },
  overrides: [
    {
      files: ["packages/dashboard/**/*.{js,jsx,ts,tsx}"],
      options: {
        sortTailwindcss: {
          stylesheet: "packages/dashboard/src/styles.css",
          functions: ["clsx", "cn", "cva", "tw"],
        },
      },
    },
  ],
  ignorePatterns,
});
