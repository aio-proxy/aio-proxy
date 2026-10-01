import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { defineConfig, normalizeHref, withSiteOrigin } from '@rspress/core';
import { pluginSitemap } from '@rspress/plugin-sitemap';
import pluginMermaid from 'rspress-plugin-mermaid';

const siteOrigin = 'https://aioproxy.dev';
// GitHub Pages serves `docs/public` at the apex. Crawlers require an absolute image URL. PNG rather than
// WebP: LinkedIn and several chat-app link previews still drop WebP cards.
const ogImageUrl = `${siteOrigin}/og-image.png`;
const ogImageAlt = 'AIO Proxy: Every model. Every client. One endpoint.';
const ogLocales: Record<string, string> = { en: 'en_US', zh: 'zh_CN' };
// Same URL shape rspress emits for its hreflang links, so canonical, og:url, and hreflang agree.
const pageUrl = (routePath: string) => withSiteOrigin(normalizeHref(routePath, true), siteOrigin);

export default defineConfig({
  root: 'docs',
  outDir: 'dist',
  title: 'AIO Proxy',
  // A `file://` URL, not a path: rspress joins a bare absolute path onto `docs/public` and only
  // runs `fileURLToPath` on the URL form. The dashboard's rsbuild config needs the opposite.
  icon: import.meta.resolve('@aio-proxy/brand/assets/aio-proxy-mark-favicon.svg'),
  description: 'Connect and manage multiple model providers through one API endpoint.',
  siteOrigin,
  route: { cleanUrls: true },
  // Rspress emits og:title, og:description, og:type, and per-locale hreflang links; everything else is here.
  // Attribute values are written into the HTML unescaped, so they must not contain double quotes.
  head: [
    ['meta', { property: 'og:site_name', content: 'AIO Proxy' }],
    ['meta', { property: 'og:image', content: ogImageUrl }],
    ['meta', { property: 'og:image:type', content: 'image/png' }],
    ['meta', { property: 'og:image:width', content: '1280' }],
    ['meta', { property: 'og:image:height', content: '640' }],
    ['meta', { property: 'og:image:alt', content: ogImageAlt }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: ogImageUrl }],
    ['meta', { name: 'twitter:image:alt', content: ogImageAlt }],
    (route) => ['link', { rel: 'canonical', href: pageUrl(route.routePath) }],
    (route) => ['meta', { property: 'og:url', content: pageUrl(route.routePath) }],
    (route) => ['meta', { property: 'og:locale', content: ogLocales[route.lang] ?? 'en_US' }],
    // Every page exists in both locales, so the other locale is always an alternate.
    (route) => ['meta', { property: 'og:locale:alternate', content: route.lang === 'zh' ? 'en_US' : 'zh_CN' }],
    // English is served at the root and is the fallback for unmatched languages.
    (route) => ['link', { rel: 'alternate', hreflang: 'x-default', href: pageUrl(route.pureRoutePath) }],
  ],
  lang: 'en',
  llms: true,
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
    pluginSitemap({ siteUrl: 'https://aioproxy.dev' }),
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
