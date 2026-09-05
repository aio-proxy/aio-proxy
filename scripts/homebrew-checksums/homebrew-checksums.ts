// sha256 of each platform tarball, for the Homebrew tap's formula.
//
// The tap pins a sha256 per platform tarball, and npm publishes no sha256 of its
// own — the packument carries only sha1 (`dist.shasum`) and sha512
// (`dist.integrity`) — so somebody has to download the tarball and hash it.
//
// Doing that inside the tap made its formula job fail on most releases: npm's
// packument is consistent the moment `npm publish` returns, but tarball reads lag
// the CDN by minutes, per package rather than per release. Doing it inside
// scripts/release.ts instead (hashing the bytes it had just uploaded) removed the
// download but put a network call on the publish script's critical path, where a
// throw skips the git tag and GitHub Release — which is exactly how v0.19.0
// shipped to npm with no tag and no Release.
//
// So it lives here, in a job that runs after everything a failure could damage.
// It waits for the CDN, hashes what the CDN actually serves — the same bytes
// `brew install` will fetch — and only then dispatches to the tap.

export type ChecksumPayload = {
  version: string;
  checksums: Record<string, string>;
};

type BuildOptions = {
  /** Unscoped platform-binary package names, e.g. `cli-darwin-arm64`. */
  packages: readonly string[];
  version: string;
  /** Fetches a tarball URL. Injected so tests do not hit the registry. */
  fetchTarball?: (url: string) => Promise<Response>;
  /** Delays between polls. Injected so tests do not actually wait. */
  wait?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

// 15 minutes per package; the worst lag observed on the tap's runs was under 10.
const ATTEMPTS = 60;
const DELAY_MS = 15_000;

export const tarballUrl = (pkg: string, version: string) =>
  `https://registry.npmjs.org/@aio-proxy/${pkg}/-/${pkg}-${version}.tgz`;

/**
 * Wait for every platform tarball to be fetchable, then hash the served bytes.
 *
 * Hashing what the CDN serves (rather than a local pack) is what makes the
 * payload trustworthy without a second cross-check: it is byte-for-byte what
 * `brew install` downloads and verifies against.
 */
export async function buildHomebrewChecksums({
  packages,
  version,
  fetchTarball = fetch,
  wait = Bun.sleep,
  log = console.log,
}: BuildOptions): Promise<ChecksumPayload> {
  // An empty payload would let the tap regenerate a formula with no bottles, so
  // fail before spending 15 minutes discovering there was nothing to wait for.
  if (packages.length === 0) {
    throw new Error('No platform packages given; the Homebrew tap would have nothing to pin');
  }

  const checksums: Record<string, string> = {};

  for (const pkg of packages) {
    const url = tarballUrl(pkg, version);
    let bytes: Uint8Array | undefined;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      // A network error is the same kind of transient as a 404 here (one release
      // died on a bare ECONNRESET), so fold it into the same retry.
      const response = await fetchTarball(url).catch((error: unknown) => String(error));
      if (typeof response !== 'string' && response.ok) {
        bytes = new Uint8Array(await response.arrayBuffer());
        break;
      }

      const reason = typeof response === 'string' ? response : `HTTP ${response.status}`;
      if (attempt === ATTEMPTS) {
        throw new Error(`${url} is still unavailable after ${ATTEMPTS} attempts: ${reason}`);
      }
      log(`${pkg}: ${reason} (attempt ${attempt}/${ATTEMPTS}); retrying in ${DELAY_MS / 1000}s`);
      await wait(DELAY_MS);
    }

    checksums[pkg] = new Bun.CryptoHasher('sha256').update(bytes!).digest('hex');
    log(`${pkg}: ${checksums[pkg]}`);
  }

  return { version, checksums };
}
