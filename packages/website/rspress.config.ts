import { fileURLToPath } from 'node:url';

import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { defineConfig } from '@rspress/core';

const uiStyles = fileURLToPath(import.meta.resolve('@aio-proxy/ui/styles.css'));

export default defineConfig({
  root: 'docs',
  outDir: 'dist',
  title: 'AIO Proxy',
  description: 'Connect and manage multiple model providers through one API endpoint.',
  builderConfig: {
    plugins: [pluginTailwindcss()],
  },
  globalStyles: uiStyles,
});
