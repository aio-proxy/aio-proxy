import { afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupServerTestLifecycle } from '#server-test-lifecycle';

const testHome = mkdtempSync(join(tmpdir(), 'aio-proxy-server-tests-'));

process.env.AIO_PROXY_HOME = testHome;
process.on('exit', () => rmSync(testHome, { force: true, recursive: true }));
afterEach(cleanupServerTestLifecycle);

// The models.dev catalog resolves through fileCacheStorage + a process-wide LRU
// before it fetches https://models.dev/api.json. Server tests seed that file
// cache under an isolated home to control /v1/models output, but a seeded entry
// that is not visible on a given cache read otherwise falls through to the live
// network and picks up drifting upstream metadata, which fails deterministically
// on CI while passing locally. Guard the one catalog endpoint the core client
// calls with the same empty OpenRouter map the seed helpers use, so no server
// unit test can reach live models.dev. Tests that must observe or control the
// catalog fetch still override globalThis.fetch themselves and restore it.
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  String(input) === 'https://models.dev/api.json'
    ? Promise.resolve(Response.json({ openrouter: { models: {} } }))
    : nativeFetch(input, init)) as typeof fetch;
