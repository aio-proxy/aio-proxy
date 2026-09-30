// Publishes one released version of the macOS app; the release `desktop` job's only build step
// (spec "Release job and feed"): reuse or build the .dmg, verify it, upload it, then replace the
// Sparkle feed on the `desktop-feed` prerelease. The feed upload is the single commit point.
//
//   bun run desktop:publish --version X.Y.Z      (from a checkout of tag vX.Y.Z)
// Env: GH_TOKEN; SPARKLE_ED_PRIVATE_KEY (only ever written to generate_appcast's stdin); plus the
// `desktop:bundle --release` env when the .dmg is not on the Release yet.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { $ } from 'bun';

import {
  MAXIMUM_VERSIONS,
  feedAction,
  feedProblems,
  feedState,
  itemProblems,
  parseAppcast,
  verifyEdSignature,
} from './appcast';
import { dmgName, verifyDmg } from './dmg';
import { DEFAULT_FEED_URL } from './info-plist';
import { fetchSparkle } from './sparkle';

const REPO = 'aio-proxy/aio-proxy';
const FEED_TAG = 'desktop-feed';
const root = join(import.meta.dir, '..', '..');
const desktop = join(root, 'desktop');
const out = join(desktop, 'target', 'bundle');

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { version: { type: 'string' } } });
const version = values.version ?? '';
if (!/^\d+\.\d+\.\d+$/u.test(version)) {
  console.error('--version X.Y.Z is required (stable versions only; canaries never ship the app)');
  process.exit(2);
}
const checkout = ((await Bun.file(join(root, 'npm/aio-proxy/package.json')).json()) as { version: string }).version;
if (checkout !== version) throw new Error(`this checkout is ${checkout}, not ${version}: check out tag v${version}`);

// The update root of trust and the write token never reach the build (cargo build scripts, bun
// lifecycle scripts); the key only ever goes to generate_appcast's stdin.
const edKey = process.env['SPARKLE_ED_PRIVATE_KEY'] ?? '';
if (edKey === '') throw new Error('SPARKLE_ED_PRIVATE_KEY is required');
// Default-env `$` calls (gh, hdiutil, codesign, tar) read the live process.env; keep the key out of them.
delete process.env['SPARKLE_ED_PRIVATE_KEY'];
const buildEnv: Record<string, string | undefined> = { ...process.env };
for (const secret of ['SPARKLE_ED_PRIVATE_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) delete buildEnv[secret];

const tag = `v${version}`;
const name = dmgName(version);
const dmg = join(out, name);
const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`;
const step = (text: string): void => console.error(`\n==> ${text}`);

step(`1. reuse or build ${name}`);
const release = await $`gh release view ${tag} --repo ${REPO} --json assets`.quiet();
const assets = (JSON.parse(release.stdout.toString()) as { assets: { name: string }[] }).assets;
const reused = assets.some((asset) => asset.name === name);
if (reused) {
  // A published version is never rebuilt: users may already have these exact bytes.
  await $`gh release download ${tag} --repo ${REPO} --pattern ${name} --dir ${out} --clobber`;
} else {
  await $`bun run desktop:bundle --release`.cwd(root).env(buildEnv);
}

step('2. verify the .dmg');
const mounted = await verifyDmg(dmg);
if (mounted.version !== version) throw new Error(`${name} holds version ${mounted.version}`);
if (mounted.feedUrl !== DEFAULT_FEED_URL)
  throw new Error(`${name} points at feed ${mounted.feedUrl}, not the product feed`);
const bytes = new Uint8Array(await Bun.file(dmg).arrayBuffer());
const signatureProblems = async (signature: string | undefined): Promise<string[]> =>
  signature === undefined || (await verifyEdSignature(bytes, signature, mounted.publicEdKey))
    ? [] // a missing signature is reported by itemProblems
    : [`${version}: sparkle:edSignature does not verify against the app's SUPublicEDKey`];

step('3. upload and check the versioned URL');
// No --clobber: a released attachment is never replaced.
if (!reused) await $`gh release upload ${tag} ${dmg} --repo ${REPO}`;
await waitForDownload(url, bytes.length);

step('4. feed');
const feedDir = mkdtempSync(join(tmpdir(), 'aio-proxy-feed-'));
try {
  const view = await $`gh release view ${FEED_TAG} --repo ${REPO} --json assets`.nothrow().quiet();
  const state = feedState(view.exitCode, view.stdout.toString(), view.stderr.toString());
  // `empty` (Release without appcast.xml) can follow a failed --clobber upload; starting fresh would
  // drop every published version, so only a missing Release may begin a new feed.
  if (state === 'empty') {
    throw new Error(
      `${FEED_TAG} has no appcast.xml; refusing to start a fresh feed that would drop published versions. Restore appcast.xml, or delete the ${FEED_TAG} Release to deliberately start over.`,
    );
  }
  if (state === 'missing-release') {
    await $`gh release create ${FEED_TAG} --repo ${REPO} --prerelease --latest=false --title ${'Desktop update feed'} --notes ${'Holds only appcast.xml, the macOS app update feed. Not a product release.'}`;
  } else {
    await $`gh release download ${FEED_TAG} --repo ${REPO} --pattern appcast.xml --dir ${feedDir}`;
  }
  const previous = state === 'missing-release' ? [] : parseAppcast(await Bun.file(join(feedDir, 'appcast.xml')).text());
  // A captive page or format change would parse to nothing and regenerate a feed that drops every
  // published version.
  if (state === 'present' && previous.length === 0) {
    throw new Error(`${FEED_TAG} appcast.xml has no items; refusing to treat it as an empty feed`);
  }
  const expected = { version, url, length: bytes.length };
  const action = feedAction(previous, version);
  if (action.kind === 'superseded') {
    console.error(`the feed already offers ${action.newest}; ${version} is not added`);
  } else if (action.kind === 'already-published') {
    const problems = [...itemProblems(action.item, expected), ...(await signatureProblems(action.item.edSignature))];
    if (problems.length > 0)
      throw new Error(`the feed's ${version} item does not match ${name}:\n${problems.join('\n')}`);
    console.error(`the feed already offers ${version} for these bytes`);
  } else {
    copyFileSync(dmg, join(feedDir, name));
    const sparkle = await fetchSparkle(join(desktop, 'vendor'));
    const generate = Bun.spawn(
      [
        join(sparkle, 'bin/generate_appcast'),
        '--ed-key-file',
        '-',
        '--download-url-prefix',
        `https://github.com/${REPO}/releases/download/${tag}/`,
        '--maximum-versions',
        String(MAXIMUM_VERSIONS),
        '--versions',
        version,
        feedDir,
      ],
      { stdin: new Blob([edKey]), stdout: 'inherit', stderr: 'inherit', env: buildEnv },
    );
    if ((await generate.exited) !== 0) throw new Error('generate_appcast failed');
    const next = parseAppcast(await Bun.file(join(feedDir, 'appcast.xml')).text());
    const added = next.find((item) => item.version === version);
    const problems = [
      ...feedProblems({ ...expected, previous, next }),
      ...(await signatureProblems(added?.edSignature)),
    ];
    if (problems.length > 0) throw new Error(`refusing to replace the feed:\n${problems.join('\n')}`);
    await $`gh release upload ${FEED_TAG} ${join(feedDir, 'appcast.xml')} --repo ${REPO} --clobber`;
    console.error(`the feed now offers ${version}`);
  }
} finally {
  rmSync(feedDir, { recursive: true, force: true });
}

// A fresh Release asset can take a moment to be served; the feed must never point at a 404. A
// different length under the same name means different bytes and stops the job.
async function waitForDownload(target: string, length: number): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await fetch(target, { method: 'HEAD', redirect: 'follow' }).catch(() => undefined);
    if (response?.status === 200) {
      const served = response.headers.get('content-length');
      if (served !== String(length)) throw new Error(`${target} serves ${served} bytes, local ${name} has ${length}`);
      return;
    }
    await Bun.sleep(3_000);
  }
  throw new Error(`${target} did not answer 200`);
}
