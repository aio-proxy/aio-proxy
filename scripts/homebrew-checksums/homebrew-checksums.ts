export type ChecksumPayload = {
  version: string;
  checksums: Record<string, string>;
};

/** Read the published SHA256SUMS, so notification retries use the released bytes. */
export function buildHomebrewChecksums({
  packages,
  version,
  manifest,
}: {
  packages: readonly string[];
  version: string;
  manifest: string;
}): ChecksumPayload {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (packages.length === 0) throw new Error('No platform packages given; the Homebrew tap would have nothing to pin');
  const files = new Map<string, string>();
  for (const line of manifest.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || files.has(match[2]!)) throw new Error('Invalid or duplicate SHA256SUMS entry');
    files.set(match[2]!, match[1]!);
  }
  const checksums: Record<string, string> = {};
  for (const pkg of packages) {
    const checksum = files.get(`${pkg}-${version}.tgz`);
    if (!checksum) throw new Error(`Missing checksum for ${pkg}@${version}`);
    checksums[pkg] = checksum;
  }
  return { version, checksums };
}
