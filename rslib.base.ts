import { defineConfig } from "@rslib/core";
import type { LibConfig, RsbuildPlugin } from "@rslib/core";

type SourceEntry = NonNullable<NonNullable<LibConfig["source"]>["entry"]>;

export type LibraryBuildOptions = {
  readonly entry?: SourceEntry;
  readonly plugins?: RsbuildPlugin[];
};

export const defineLibraryConfig = (options: LibraryBuildOptions = {}) =>
  defineConfig({
    plugins: options.plugins,
    lib: [
      {
        format: "esm",
        dts: true,
        source: {
          entry: options.entry ?? {
            index: "./src/index.ts",
          },
        },
        output: {
          distPath: {
            root: "./dist",
          },
        },
      },
    ],
  });
