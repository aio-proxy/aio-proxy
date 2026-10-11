import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Root-launched `bun test packages/...` skips each package's own preload, and an
// inherited NODE_ENV can disable the aioHome() guard, so isolate the home here.
// Always override: an inherited AIO_PROXY_HOME may point at a live instance.
const testHome = mkdtempSync(join(tmpdir(), 'aio-proxy-root-tests-'));
process.env['AIO_PROXY_HOME'] = testHome;
process.on('exit', () => rmSync(testHome, { force: true, recursive: true }));
