import { fileURLToPath } from 'node:url';

import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSvgr } from '@rsbuild/plugin-svgr';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { tanstackRouter } from '@tanstack/router-plugin/rspack';

const apiUrl = `http://127.0.0.1:${process.env.AIO_PROXY_PORT ?? '9317'}`;

// A real path, not a `file://` URL: rsbuild resolves `html.favicon` against the project root
// unless it is absolute. The website's rspress config needs the opposite.
const favicon = fileURLToPath(import.meta.resolve('@aio-proxy/brand/assets/aio-proxy-mark-favicon.svg'));

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
          target: 'react',
          autoCodeSplitting: true,
          generatedRouteTree: './src/route-tree.gen.ts',
        }),
      ],
    },
  },
  output: {
    assetPrefix: '/dashboard/',
  },
  html: {
    title: 'AIO Proxy Dashboard',
    favicon,
  },
  server: {
    base: '/dashboard/',
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    proxy: {
      '/dashboard/api': {
        target: apiUrl,
        on: {
          proxyReq: (proxyReq) => {
            proxyReq.setHeader('Origin', apiUrl);
          },
        },
      },
    },
  },
});
