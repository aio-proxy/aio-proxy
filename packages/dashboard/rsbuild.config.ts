import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginSvgr } from "@rsbuild/plugin-svgr";
import { pluginTailwindcss } from "@rsbuild/plugin-tailwindcss";
import { tanstackRouter } from "@tanstack/router-plugin/rspack";

// Docs: https://rsbuild.rs/config/
export default defineConfig({
  plugins: [
    pluginReact({
      reactCompiler: true,
    }),
    pluginSvgr(),
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
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    proxy: {
      "/dashboard/api": {
        target: "http://127.0.0.1:22078",
        on: {
          proxyReq: (proxyReq) => {
            proxyReq.setHeader("Origin", "http://127.0.0.1:22078");
          },
        },
      },
    },
  },
});
