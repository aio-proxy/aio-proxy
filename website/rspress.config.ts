import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { defineConfig } from '@rspress/core';
import pluginMermaid from 'rspress-plugin-mermaid';

export default defineConfig({
  root: 'docs',
  outDir: 'dist',
  title: 'AIO Proxy',
  // A `file://` URL, not a path: rspress joins a bare absolute path onto `docs/public` and only
  // runs `fileURLToPath` on the URL form. The dashboard's rsbuild config needs the opposite.
  icon: import.meta.resolve('@aio-proxy/brand/assets/aio-proxy-mark-favicon.svg'),
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
  plugins: [
    pluginMermaid({
      mermaidConfig: {
        theme: 'neutral',
        flowchart: {
          curve: 'monotoneY',
        },
      },
    }),
  ],
  builderConfig: {
    plugins: [pluginTailwindcss()],
    tools: {
      bundlerChain(chain, { CHAIN_ID }) {
        if (!chain.plugins.has(CHAIN_ID.PLUGIN.REACT_FAST_REFRESH)) return;
        chain.plugin(CHAIN_ID.PLUGIN.REACT_FAST_REFRESH).tap((options) => {
          options[0] ??= {};
          // Rspress widens refresh to dependencies, where Scalar's `Promise` export shadows the injected runtime call.
          options[0].exclude = /[\\/]node_modules[\\/]/;
          return options;
        });
      },
    },
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
