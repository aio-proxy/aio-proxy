// sha256 of each platform tarball, for the Homebrew tap's formula.
//
// The tap pins a sha256 per platform tarball, and npm publishes no sha256 of its
// own — the packument carries only sha1 (`dist.shasum`) and sha512
// (`dist.integrity`) — so somebody has to download the tarball and hash it.
//
// Doing that inside the tap made its formula job fail on most releases: tarball
// reads lag npm's CDN by minutes, per package rather than per release. Doing it
// inside scripts/release.ts instead (hashing the bytes it had just uploaded)
// removed the download but put a network call on the publish script's critical
// path, where a throw skips the git tag and GitHub Release — which is exactly how
// v0.19.0 shipped to npm with no tag and no Release. (That release also disproved
// the assumption behind the move: the packument is NOT consistent the moment `npm
// publish` returns.)
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

// 15 minutes; the worst per-package lag observed on the tap's runs was under 10.
// Packages are waited on concurrently — the CDN propagates them in parallel, so
// this is the budget for the whole set, not per package.
const ATTEMPTS = 60;
const DELAY_MS = 15_000;

export const tarballUrl = (pkg: string, version: string) =>
  `https://registry.npmjs.org/@aio-proxy/${pkg}/-/${pkg}-${version}.tgz`;

// A `string` is how a failed attempt travels back through `.catch()`, so that a
// success (`Uint8Array`) and a failure stay distinguishable without a throw.
const describeFailure = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  // fail before spending the wait discovering there was nothing to wait for.
  if (packages.length === 0) {
    throw new Error('No platform packages given; the Homebrew tap would have nothing to pin');
  }

  // Concurrently: npm propagates the packages independently but at the same time,
  // so waiting on them in series would bill the slowest package's lag once per
  // package. Promise.all rejects on the first exhausted package, which is the
  // behavior we want — a missing tarball fails the job either way. It also keeps
  // the result in `packages` order rather than completion order, so the payload
  // is byte-stable across runs.
  const entries = await Promise.all(packages.map(async (pkg) => [pkg, await hashTarball(pkg)] as const));

  return { version, checksums: Object.fromEntries(entries) };

  async function hashTarball(pkg: string): Promise<string> {
    const url = tarballUrl(pkg, version);

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      // A network error is the same kind of transient as a 404 here (one release
      // died on a bare ECONNRESET), so fold it into the same retry. The body read
      // is inside the boundary too: a connection that resets mid-tarball answers
      // with successful headers and only fails once the stream is drained, which
      // is the same transient arriving a few hundred milliseconds later.
      const outcome = await readTarball(url).catch(describeFailure);
      if (typeof outcome !== 'string') {
        const sha256 = new Bun.CryptoHasher('sha256').update(outcome).digest('hex');
        log(`${pkg}: ${sha256}`);
        return sha256;
      }

      if (attempt === ATTEMPTS) {
        throw new Error(`${url} is still unavailable after ${ATTEMPTS} attempts: ${outcome}`);
      }
      log(`${pkg}: ${outcome} (attempt ${attempt}/${ATTEMPTS}); retrying in ${DELAY_MS / 1000}s`);
      await wait(DELAY_MS);
    }

    throw new Error(`unreachable: ${pkg} exhausted its attempts without resolving`);
  }

  /** Throws on a non-2xx, a failed connection, or a body that dies mid-stream. */
  async function readTarball(url: string): Promise<Uint8Array> {
    const response = await fetchTarball(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
