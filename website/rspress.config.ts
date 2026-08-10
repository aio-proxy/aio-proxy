import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { defineConfig } from '@rspress/core';
import pluginMermaid from 'rspress-plugin-mermaid';

export default defineConfig({
  root: 'docs',
  outDir: 'dist',
  title: 'AIO Proxy',
  icon: '/favicon.svg',
  description: 'Connect and manage multiple model providers through one API endpoint.',
  lang: 'en',
  locales: [
    {
      lang: 'en',
      label: 'English',
    },
    {
      lang: 'zh',
      label: '简体中文',
    },
  ],
  plugins: [pluginMermaid()],
  builderConfig: {
    plugins: [pluginTailwindcss()],
  },
  themeConfig: {
    socialLinks: [
      {
        icon: 'github',
        mode: 'link',
        content: 'https://github.com/aio-proxy/aio-proxy',
      },
    ],
  },
});
