#!/usr/bin/env bun
import { uploadReleaseAssets } from './release-assets';

const [version, directory] = process.argv.slice(2);
if (!version || !directory)
  throw new Error('usage: bun run scripts/upload-release-assets.ts <version> <asset-directory>');
const launcher = (await Bun.file('npm/aio-proxy/package.json').json()) as {
  optionalDependencies: Record<string, string>;
};
await uploadReleaseAssets({
  version,
  directory,
  packages: Object.keys(launcher.optionalDependencies).map((name) => name.replace('@aio-proxy/', '')),
});
