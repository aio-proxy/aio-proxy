#!/usr/bin/env bun
// The Release manifest is uploaded after all four platform tarballs.

import { $ } from 'bun';

import { buildHomebrewChecksums } from './homebrew-checksums';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`usage: bun run scripts/homebrew-notify.ts <version>  (got ${version ?? 'nothing'})`);
}

// The tap's formula pins exactly the launcher's optionalDependencies, so read
// them rather than keeping a second list in sync by hand.
const launcher = (await Bun.file('npm/aio-proxy/package.json').json()) as {
  optionalDependencies?: Record<string, string>;
};
const packages = Object.keys(launcher.optionalDependencies ?? {}).map((name) => name.replace(/^@aio-proxy\//, ''));

const dispatch = process.env['HOMEBREW_TAP_DISPATCH'] !== 'false';
const token = process.env['HOMEBREW_TAP_TOKEN'];
if (dispatch && !token) {
  throw new Error('HOMEBREW_TAP_TOKEN is not set (pass HOMEBREW_TAP_DISPATCH=false to only print the payload)');
}

const manifest = (
  await $`gh release download ${`v${version}`} --repo aio-proxy/aio-proxy --pattern SHA256SUMS --output -`.quiet()
).text();
const payload = buildHomebrewChecksums({ packages, version, manifest });

if (!dispatch) {
  console.log(`\n[no-dispatch] payload:\n${JSON.stringify(payload, null, 2)}`);
  process.exit(0);
}

// The source distinguishes Release attachments from older npm-backed notifications.
const response = await fetch('https://api.github.com/repos/aio-proxy/homebrew-tap/dispatches', {
  method: 'POST',
  signal: AbortSignal.timeout(30_000),
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  },
  body: JSON.stringify({ event_type: 'aio-proxy-release', client_payload: payload }),
});
if (!response.ok) {
  throw new Error(`homebrew-tap dispatch failed: HTTP ${response.status} ${await response.text()}`);
}

console.log(`\nDispatched ${Object.keys(payload.checksums).length} checksum(s) for v${version} to homebrew-tap`);
