import {
  defineConfig,
  mergeRslibConfig,
  type RsbuildPlugin,
  type RslibConfig,
} from "@rslib/core";

type LibraryBuildConfig = Omit<RslibConfig, "lib"> & {
  readonly lib?: RslibConfig["lib"];
};

export type { RsbuildPlugin };

export const defineLibraryConfig = (
  options: LibraryBuildConfig = {},
): RslibConfig => {
  const baseConfig: RslibConfig = {
    lib: [
      {
        id: "library",
        format: "esm",
        bundle: false,
        dts: true,
        source: {
          entry: {
            index: [
              "./src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
              "!./src/**/*.d.ts",
            ],
          },
        },
        output: {
          distPath: {
            root: "./dist",
          },
        },
      },
    ],
  };
  const mergedConfig = mergeRslibConfig(baseConfig, options);

  return defineConfig({
    ...mergedConfig,
    lib: mergedConfig.lib ?? baseConfig.lib,
  });
};
