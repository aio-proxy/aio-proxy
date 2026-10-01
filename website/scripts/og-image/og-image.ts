import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Renders docs/public/og-image.png from og-image.html with Bun's built-in headless browser.
// Pinned to the Chrome backend (Bun finds the installed Chrome, or BUN_CHROME_PATH) so the viewport can be set
// exactly over CDP: the macOS WebKit backend captures at the display's pixel ratio, and Chrome's `width`/`height`
// size the window rather than the page. Either would miss the 1280x640 declared in rspress.config.ts.
const output = join(import.meta.dir, '..', '..', 'docs', 'public', 'og-image.png');

const readBrandSvg = (name: string) =>
  Bun.file(fileURLToPath(import.meta.resolve(`@aio-proxy/brand/assets/${name}`))).text();

// The same font files the site loads through @aio-proxy/ui, inlined so rendering needs no network.
const uiPackageDir = join(import.meta.dir, '..', '..', '..', 'packages', 'ui');
const fontFace = async (family: string, file: string) => {
  const bytes = await Bun.file(Bun.resolveSync(file, uiPackageDir)).bytes();
  return `@font-face { font-family: '${family}'; font-weight: 100 900; src: url(data:font/woff2;base64,${bytes.toBase64()}) format('woff2'); }`;
};
const fonts = [
  await fontFace('Lexend', '@fontsource-variable/lexend/files/lexend-latin-wght-normal.woff2'),
  await fontFace('JetBrains Mono', '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2'),
].join('\n');

const html = (await Bun.file(join(import.meta.dir, 'og-image.html')).text())
  .replace('{{fonts}}', fonts)
  .replace('{{wordmark}}', await readBrandSvg('aio-proxy-wordmark.svg'))
  .replace('{{mark}}', await readBrandSvg('aio-proxy-mark.svg'));

await using view = new Bun.WebView({ backend: 'chrome' });
await view.navigate(`data:text/html,${encodeURIComponent(html)}`);
await view.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false });
await view.evaluate('document.fonts.ready');
await Bun.write(output, await view.screenshot());
console.log(`Wrote ${output}`);
