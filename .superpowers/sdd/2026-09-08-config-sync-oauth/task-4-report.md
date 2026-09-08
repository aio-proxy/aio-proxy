# Task 4 implementation report

## Status

Implemented the OAuth sharing service surface for first share, shared replacement, verified local detachment, and cancellation of an in-memory detach candidate.

## Changes

- Added `OAuthSharingService` and `createOAuthSharingService` under `packages/core/src/sync/oauth/sharing`.
- First share reads the exact local account under the provider gate, validates the adapter sync format, creates the remote account with generation zero using CAS, and records local shared ownership only after the remote write succeeds.
- Existing remote accounts are reconciled by payload comparison and never overwritten by first share.
- Shared replacement advances the remote generation with CAS and stages the local account update before publishing shared ownership metadata.
- Detachment requires the adapter's `credentialSync.canDetach` proof. Failed or unsupported proof leaves shared ownership intact; successful proof stages the candidate account and marks the local entity independent atomically within the account transaction.

## Verification

- `bunx tsc --noEmit -p packages/core/tsconfig.json` — passed.

## Concerns

- The current task branch does not contain the task brief's `withOAuthSharingFixture`; focused behavioral coverage for the new service could not be added without duplicating the repository fixture and backend harness.
- The service currently keeps a pending detach candidate in process memory. Durable pending-journal recovery and server lifecycle wiring remain to be completed by the coordinating agent.

## Fix round 1

Added durable OAuth journal entries around first-share and detach, persisted `detach-pending` ownership before asynchronous verification, cancellation generation fencing, evidence validation, unknown remote record handling, and replacement epoch/plugin metadata preservation.

Verification: `bunx tsc --noEmit -p packages/core/tsconfig.json` — exit 0 (no diagnostics).
