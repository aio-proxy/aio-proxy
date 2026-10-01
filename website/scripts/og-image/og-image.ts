import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Renders docs/public/og-image.png from og-image.html with Bun's built-in headless browser.
// Pinned to the Chrome backend (Bun finds the installed Chrome, or BUN_CHROME_PATH) so the viewport can be set
// exactly over CDP: the macOS WebKit backend captures at the display's pixel ratio, and Chrome's `width`/`height`
// size the window rather than the page. Either would miss the 1280x640 declared in rspress.config.ts.
// The template loads Lexend and JetBrains Mono from Google Fonts, so rendering needs network access.
const output = join(import.meta.dir, '..', '..', 'docs', 'public', 'og-image.png');

const readBrandSvg = (name: string) =>
  Bun.file(fileURLToPath(import.meta.resolve(`@aio-proxy/brand/assets/${name}`))).text();

const html = (await Bun.file(join(import.meta.dir, 'og-image.html')).text())
  .replace('{{wordmark}}', await readBrandSvg('aio-proxy-wordmark.svg'))
  .replace('{{mark}}', await readBrandSvg('aio-proxy-mark.svg'));

await using view = new Bun.WebView({ backend: 'chrome' });
await view.navigate(`data:text/html,${encodeURIComponent(html)}`);
await view.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false });
await view.evaluate('document.fonts.ready');
await Bun.write(output, await view.screenshot());
console.log(`Wrote ${output}`);
