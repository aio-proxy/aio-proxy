import { join } from 'node:path';

export type ChecksumPayload = {
  version: string;
  source: 'github-release';
  checksums: Record<string, string>;
};

/** Hash the saved pack output; never wait for npm to serve a just-published version. */
export async function buildHomebrewChecksums({
  packages,
  version,
  directory,
}: {
  packages: readonly string[];
  version: string;
  directory: string;
}): Promise<ChecksumPayload> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (packages.length === 0) throw new Error('No platform packages given; the Homebrew tap would have nothing to pin');
  const checksums: Record<string, string> = {};
  for (const pkg of packages) {
    if (!/^cli-(darwin|linux)-(arm64|x64)$/.test(pkg)) throw new Error(`Invalid platform package: ${pkg}`);
    const bytes = await Bun.file(join(directory, `${pkg}-${version}.tgz`)).bytes();
    checksums[pkg] = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  }
  return { version, source: 'github-release', checksums };
}
