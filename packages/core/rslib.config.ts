import { defineLibraryConfig } from "@aio-proxy/infra/rslib";

export default defineLibraryConfig({
  lib: [
    {
      id: "library",
      format: "esm",
      bundle: false,
      dts: true,
      source: {
        entry: {
          index: ["./src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}", "!./src/**/*.d.ts", "!./src/db/migrations.manifest.ts"],
        },
      },
      output: {
        distPath: {
          root: "./dist",
        },
      },
    },
    {
      id: "migrations-manifest",
      format: "esm",
      bundle: true,
      dts: true,
      source: {
        entry: {
          "db/migrations.manifest": "./src/db/migrations.manifest.ts",
        },
      },
      output: {
        distPath: {
          root: "./dist",
        },
      },
    },
  ],
  tools: {
    rspack(_config, { addRules }) {
      addRules([
        {
          resourceQuery: /raw/,
          type: "asset/source",
        },
      ]);
    },
  },
});
