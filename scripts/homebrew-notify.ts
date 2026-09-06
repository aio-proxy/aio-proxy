#!/usr/bin/env bun
// Hand the Homebrew tap the sha256 of each platform tarball this release published.
//
// Runs as its own workflow job, after publish/tag/Release/docker, because it has
// to wait on npm's CDN (see scripts/homebrew-checksums) and nothing downstream of
// a release should be able to break by waiting. Reads the version from argv so
// the job passes whatever `published-packages` reported, and dispatches the
// payload to aio-proxy/homebrew-tap itself.

import { buildHomebrewChecksums } from './homebrew-checksums';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
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
// Checked before the wait, not after: discovering a missing secret is worth
// seconds, not the quarter hour the CDN poll can take.
if (dispatch && !token) {
  throw new Error('HOMEBREW_TAP_TOKEN is not set (pass HOMEBREW_TAP_DISPATCH=false to only print the payload)');
}

const payload = await buildHomebrewChecksums({ packages, version });

if (!dispatch) {
  console.log(`\n[no-dispatch] payload:\n${JSON.stringify(payload, null, 2)}`);
  process.exit(0);
}

// client_payload caps top-level properties at 10; version + checksums = 2.
const response = await fetch('https://api.github.com/repos/aio-proxy/homebrew-tap/dispatches', {
  method: 'POST',
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
