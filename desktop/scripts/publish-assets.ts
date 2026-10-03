// Publishes the Linux AppImages and the Windows installer of one released version, each with its
// `.minisig`, to Release v<version> (spec "Release job and feed", `publish-assets`). Resumable: every
// target is re-planned from what the Release holds, and only bytes this run built are ever signed.
//
//   bun run desktop:publish-assets --version X.Y.Z --dir <artifacts dir>
// Env: GH_TOKEN; SPARKLE_ED_PRIVATE_KEY (the minisign key) and SPARKLE_PUBLIC_ED_KEY (its public key).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { $ } from 'bun';

import { publicKeyFromPrivate, signMinisign, TARGETS, trustedComment } from './minisign';
import { assetName } from './package/index';
import { assetStep, verifyPair } from './publish-assets/index';

const REPO = 'aio-proxy/aio-proxy';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { version: { type: 'string' }, dir: { type: 'string' } },
});
const version = values.version ?? '';
if (!/^\d+\.\d+\.\d+$/u.test(version) || values.dir === undefined) {
  console.error('Usage: desktop:publish-assets --version X.Y.Z --dir <artifacts dir> (stable versions only)');
  process.exit(2);
}
const dir = resolve(values.dir);

const edKey = process.env['SPARKLE_ED_PRIVATE_KEY'] ?? '';
if (edKey === '') throw new Error('SPARKLE_ED_PRIVATE_KEY is required');
// Bun's `$` reads the live process.env; removing the key keeps it out of every gh call, which also
// gets an explicit env without it.
delete process.env['SPARKLE_ED_PRIVATE_KEY'];
const ghEnv: Record<string, string | undefined> = { ...process.env };

// A key that does not match the apps' baked-in public key would publish updates nobody can install;
// checked before any gh call.
const publicKey = await publicKeyFromPrivate(edKey);
if (process.env['SPARKLE_PUBLIC_ED_KEY'] !== publicKey) {
  throw new Error(
    'SPARKLE_PUBLIC_ED_KEY is unset or is not the public key of SPARKLE_ED_PRIVATE_KEY: the pair does not match',
  );
}

// download-artifact nests each artifact in its own folder, so the inputs are found by name anywhere
// under --dir. A rehearsal build points at another feed or key and must never reach a Release.
const files = [...new Bun.Glob('**/*').scanSync({ cwd: dir, onlyFiles: true })];
const rehearsals = files.filter((file) => basename(file).includes('-rehearsal'));
if (rehearsals.length > 0) throw new Error(`refusing rehearsal builds: ${rehearsals.join(', ')}`);
const inputs = TARGETS.map((target) => {
  const name = assetName(target, version);
  const found = files.filter((file) => basename(file) === name);
  if (found.length !== 1) throw new Error(`expected exactly one ${name} under ${dir}, found ${found.length}`);
  return { target, name, path: join(dir, found[0] ?? '') };
});

const tag = `v${version}`;
const step = (text: string): void => console.error(`\n==> ${text}`);
const work = mkdtempSync(join(tmpdir(), 'aio-proxy-assets-'));
try {
  step(`1. list the assets on ${tag}`);
  const release = await $`gh release view ${tag} --repo ${REPO} --json assets`.env(ghEnv).quiet();
  const published = new Set(
    (JSON.parse(release.stdout.toString()) as { assets: { name: string }[] }).assets.map((asset) => asset.name),
  );

  for (const { target, name, path } of inputs) {
    const sigName = `${name}.minisig`;
    const comment = trustedComment(version, target, name);
    const action = assetStep({ asset: published.has(name), minisig: published.has(sigName) });
    step(`2. ${target}: ${action}`);
    const download = async (asset: string): Promise<string> => {
      // --pattern is a glob; asset names are [A-Za-z0-9._-], so it matches only this name. The work
      // directory is fresh and each name is fetched once, so no --clobber.
      await $`gh release download ${tag} --repo ${REPO} --pattern ${asset} --dir ${work}`.env(ghEnv).quiet();
      return join(work, asset);
    };
    // No --clobber on uploads: a published attachment is never replaced.
    const upload = async (file: string): Promise<void> => {
      await $`gh release upload ${tag} ${file} --repo ${REPO}`.env(ghEnv);
    };

    if (action === 'sign-and-upload') {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      const sigPath = join(work, sigName);
      await Bun.write(sigPath, await signMinisign(bytes, edKey, comment));
      await upload(sigPath);
      await upload(path);
    } else if (action === 'upload-verified-asset') {
      // Builds are not reproducible, so this usually fails: the orphan was signed over another build.
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      const minisig = await Bun.file(await download(sigName)).text();
      if (!(await verifyPair(bytes, minisig, publicKey, comment))) {
        throw new Error(
          `${sigName} on ${tag} does not verify this run's ${name} (an interrupted earlier run signed another build). Delete the orphan, then re-dispatch:\n  gh release delete-asset ${tag} ${sigName} --repo ${REPO} --yes`,
        );
      }
      await upload(path);
    } else {
      const bytes = new Uint8Array(await Bun.file(await download(name)).arrayBuffer());
      const minisig = await Bun.file(await download(sigName)).text();
      if (!(await verifyPair(bytes, minisig, publicKey, comment))) {
        throw new Error(`${name} and ${sigName} on ${tag} do not verify against the update key and "${comment}"`);
      }
      console.error(`${name} is published and verifies`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
