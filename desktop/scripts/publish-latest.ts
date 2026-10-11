// Points the Linux/Windows update feed (`latest.json` on the `desktop-feed` prerelease) at the highest
// stable Release among the newest 20 whose three builds and `.minisig` files are present and verify (spec
// "Release job and feed", `feed`). Independent of the dispatched tag, and never moves the feed down.
//
//   bun run desktop:publish-latest
// Env: GH_TOKEN; SPARKLE_PUBLIC_ED_KEY (the update public key). No signing key: it only verifies.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

import {
  assetUrl,
  buildLatestJson,
  feedCandidates,
  feedSignaturesVerify,
  parseLatestJson,
  pickFeedVersion,
  REPO,
  TARGETS,
} from './latest-json/index';
import type { UpdateTarget } from './latest-json/index';
import { trustedComment } from './minisign';
import { assetName, latestAssetName } from './package/index';
import { verifyPair } from './publish-assets/index';

const FEED_TAG = 'desktop-feed';
const FEED = 'latest.json';

const publicKey = process.env['SPARKLE_PUBLIC_ED_KEY'] ?? '';
if (publicKey === '') throw new Error('SPARKLE_PUBLIC_ED_KEY is required');

const step = (text: string): void => console.error(`\n==> ${text}`);
const assetsOf = async (tag: string): Promise<Set<string>> => {
  const view = await $`gh release view ${tag} --repo ${REPO} --json assets`.quiet();
  return new Set((JSON.parse(view.stdout.toString()) as { assets: { name: string }[] }).assets.map((a) => a.name));
};

const work = mkdtempSync(join(tmpdir(), 'aio-proxy-feed-'));
try {
  // A missing desktop-feed fails here: the macOS job owns its creation.
  step(`1. read ${FEED} on ${FEED_TAG}`);
  const feedAssets = await assetsOf(FEED_TAG).catch((error: unknown) => {
    throw new Error(`cannot read the ${FEED_TAG} Release (the macOS release job creates it)`, { cause: error });
  });
  let current: string | undefined;
  // A current feed missing a target's entry may be rewritten at its own version, so redispatching repairs it.
  let repair = false;
  if (feedAssets.has(FEED)) {
    await $`gh release download ${FEED_TAG} --repo ${REPO} --pattern ${FEED} --dir ${work}`.quiet();
    // An unreadable feed is not "no feed": treating it as absent could move the feed down.
    const currentText = await Bun.file(join(work, FEED)).text();
    const parsed = parseLatestJson(currentText);
    current = parsed?.version;
    if (current === undefined || !/^\d+\.\d+\.\d+$/u.test(current)) {
      throw new Error(`${FEED} on ${FEED_TAG} is not a stable X.Y.Z feed; fix or delete it by hand`);
    }
    repair = parsed?.complete === false || !(await feedSignaturesVerify(currentText, publicKey));
    if (repair) console.error(`${FEED} lacks a usable entry for some target; it may be rewritten at ${current}`);
  }
  console.error(`feed version: ${current ?? '(none)'}`);

  step('2. list the newest 20 stable Releases');
  const list =
    await $`gh release list --repo ${REPO} --exclude-drafts --exclude-pre-releases --limit 20 --json tagName`.quiet();
  const candidates = feedCandidates(
    current,
    (JSON.parse(list.stdout.toString()) as { tagName: string }[]).map((release) => release.tagName),
    repair,
  );

  // Highest first, so the first complete Release is the pick and older builds are never downloaded.
  const checked: { version: string; complete: boolean }[] = [];
  let entries = new Map<UpdateTarget, { url: string; minisig: string }>();
  for (const version of candidates) {
    const tag = `v${version}`;
    step(`3. is ${tag} complete`);
    const published = await assetsOf(tag);
    const dir = join(work, tag);
    mkdirSync(dir);
    entries = new Map();
    for (const target of TARGETS) {
      const name = assetName(target, version);
      if (!published.has(name) || !published.has(`${name}.minisig`)) {
        console.error(`${tag} lacks ${name} or its .minisig`);
        break;
      }
      // --pattern is a glob; asset names are [A-Za-z0-9._-], so each matches only itself.
      // A failed download (e.g. a newer version still uploading) leaves only this candidate out.
      const download =
        await $`gh release download ${tag} --repo ${REPO} --pattern ${name} --pattern ${`${name}.minisig`} --dir ${dir}`
          .nothrow()
          .quiet();
      if (download.exitCode !== 0) {
        console.error(`cannot download ${name} from ${tag}: ${download.stderr.toString().trim()}`);
        break;
      }
      const bytes = new Uint8Array(await Bun.file(join(dir, name)).arrayBuffer());
      const minisig = await Bun.file(join(dir, `${name}.minisig`)).text();
      if (!(await verifyPair(bytes, minisig, publicKey, trustedComment(version, target, name)))) {
        console.error(`${name} on ${tag} does not verify against the update key and its trusted comment`);
        break;
      }
      entries.set(target, { url: assetUrl(version, target), minisig });
    }
    const complete = entries.size === TARGETS.length;
    checked.push({ version, complete });
    if (complete) break;
    rmSync(dir, { recursive: true, force: true });
  }

  const picked = pickFeedVersion(current, checked, repair);
  if (picked === undefined) {
    console.error(`\nno complete stable Release above ${current ?? '(none)'}; ${FEED} unchanged`);
  } else {
    // The website's download buttons link to unversioned copies. They go up before the feed, so a failed
    // run is redone by the next one, which still sees the feed below `picked`.
    step(`4. unversioned downloads for ${picked}`);
    for (const target of TARGETS) {
      const latest = join(work, latestAssetName(target));
      copyFileSync(join(work, `v${picked}`, assetName(target, picked)), latest);
      await $`gh release upload ${FEED_TAG} ${latest} --repo ${REPO} --clobber`;
    }

    step(`5. publish ${FEED} for ${picked}`);
    const feed = join(work, FEED);
    await Bun.write(feed, buildLatestJson(picked, entries));
    await $`gh release upload ${FEED_TAG} ${feed} --repo ${REPO} --clobber`;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
