// sha256 of each platform tarball, for the Homebrew tap's formula.
//
// The tap pins a sha256 per platform tarball. Recomputing those by downloading
// from the registry races npm's CDN: the packument is consistent the moment
// `npm publish` returns, but a tarball can 404 for several minutes afterwards —
// per package, not per release — which is what made the tap's formula job fail
// and need manual reruns. These are the exact bytes `npm publish` just uploaded,
// so hashing them here lets the tap skip the download entirely.
//
// Split out of release.ts (which runs top-to-bottom on import) so the handoff is
// reachable from a test: it publishes packages but gates the Homebrew update, so
// a mistake here is invisible until a release is already half-done.

export type ChecksumPayload = {
  version: string;
  checksums: Record<string, string>;
};

type BuildOptions = {
  /** Package name -> tarball path on disk, for every packed package. */
  tarballs: ReadonlyMap<string, string>;
  /** Names of the platform-binary packages the tap's formula pins. */
  platformProvided: ReadonlySet<string>;
  version: string;
  /** Reads the tarball's bytes. */
  readBytes: (path: string) => Promise<Uint8Array>;
  /** Resolves the registry's `dist.integrity` for `<name>@<version>`, or '' when absent. */
  registryIntegrity: (name: string, version: string) => Promise<string>;
};

/**
 * Hash the platform tarballs for the tap, verifying each against the registry first.
 *
 * The bytes on disk are not automatically what the registry serves — a resumed
 * release skips publish for versions already up, and a pack could silently
 * differ. npm's `dist.integrity` is the sha512 of the stored bytes and lives in
 * the packument, which is immediately consistent, so checking it costs nothing
 * and does not reintroduce the CDN race this whole handoff exists to avoid.
 */
export async function buildHomebrewChecksums({
  tarballs,
  platformProvided,
  version,
  readBytes,
  registryIntegrity,
}: BuildOptions): Promise<ChecksumPayload> {
  const checksums: Record<string, string> = {};

  for (const [name, tgz] of tarballs) {
    if (!platformProvided.has(name)) continue;

    const bytes = await readBytes(tgz);
    const integrity = `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`;
    const advertised = await registryIntegrity(name, version);
    if (advertised !== integrity) {
      throw new Error(
        `${name}@${version}: local tarball integrity ${integrity} does not match the registry's ${advertised || '(none)'}`,
      );
    }

    checksums[name.replace(/^@aio-proxy\//, '')] = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  }

  // An empty payload would let the tap dispatch a release it cannot build a
  // formula for, so fail here instead — on the release that caused it.
  if (Object.keys(checksums).length === 0) {
    throw new Error('No platform tarballs were packed; the Homebrew tap would have nothing to pin');
  }

  return { version, checksums };
}
