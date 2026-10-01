import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Renders docs/public/og-image.png from og-image.html with headless Chrome.
// The template loads Lexend and JetBrains Mono from Google Fonts, so rendering needs network access.
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output = join(import.meta.dir, '..', '..', 'docs', 'public', 'og-image.png');

const readBrandSvg = (name: string) =>
  Bun.file(fileURLToPath(import.meta.resolve(`@aio-proxy/brand/assets/${name}`))).text();

const html = (await Bun.file(join(import.meta.dir, 'og-image.html')).text())
  .replace('{{wordmark}}', await readBrandSvg('aio-proxy-wordmark.svg'))
  .replace('{{mark}}', await readBrandSvg('aio-proxy-mark.svg'));
const page = join(await mkdtemp(join(tmpdir(), 'og-image-')), 'og-image.html');
await Bun.write(page, html);

const proc = Bun.spawn(
  [
    chrome,
    '--headless=new',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1280,640',
    // Gives the web fonts time to load before the capture.
    '--virtual-time-budget=5000',
    `--screenshot=${output}`,
    `file://${page}`,
  ],
  { stdout: 'ignore', stderr: 'ignore' },
);
if ((await proc.exited) !== 0) {
  throw new Error(`Chrome exited with ${proc.exitCode}; set CHROME_PATH if it is not installed at ${chrome}`);
}
console.log(`Wrote ${output}`);
