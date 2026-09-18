// Whether the CloudKit backend may be published. The release workflow runs `index.ts` and reads the
// printed answer to decide whether to ask for the Apple signing secrets; scripts/release.ts imports
// the same function to decide whether the package joins the publish set. One definition, so the
// signing step and the publish set cannot disagree about whether the backend is releasable.

import { join } from 'node:path';

/**
 * Whether recorded live evidence clears the CloudKit backend for publication.
 * `docs/testing/cloudkit-sync.md` calls a blocked gate a release NO-GO, but nothing read the evidence,
 * so the first publish would have shipped the backend on the strength of a successful codesign alone —
 * before its Production schema, installed entitlements and cross-device runs had ever passed.
 * `conformance-live.ts` cannot write the clearing value: the launchd-service and Production-container
 * runs are manual, so it stops at `unverified` and `passed` is recorded by hand once those pass. Every
 * other value withholds the backend, as does an unreadable or absent file — a release that cannot read
 * its own evidence has verified nothing. `APPLE_CLOUDKIT_EVIDENCE_PATH` redirects the read exactly as
 * it redirects the writers, so the gate follows the evidence a run was told to record.
 */
export async function cloudKitReleaseGatePassed(): Promise<boolean> {
  const path =
    process.env['APPLE_CLOUDKIT_EVIDENCE_PATH'] ??
    join(import.meta.dir, '..', '..', 'docs', 'testing', 'evidence', 'cloudkit-sync.json');
  const evidence = (await Bun.file(path)
    .json()
    .catch(() => undefined)) as { readonly productionGate?: unknown } | undefined;
  return evidence?.productionGate === 'passed';
}
