import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginTailwindcss } from "@rsbuild/plugin-tailwindcss";
import { tanstackRouter } from "@tanstack/router-plugin/rspack";

// Docs: https://rsbuild.rs/config/
export default defineConfig({
  plugins: [
    pluginReact({
      reactCompiler: true,
    }),
    pluginTailwindcss(),
  ],
  tools: {
    rspack: {
      plugins: [
        tanstackRouter({
          target: "react",
          autoCodeSplitting: true,
          generatedRouteTree: "./src/route-tree.gen.ts",
        }),
      ],
    },
  },
  output: {
    assetPrefix: "/dashboard/",
  },
  html: {
    title: "AIO Proxy Dashboard",
  },
});
