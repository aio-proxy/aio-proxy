# OAuth sync verification

OAuth adapters declare a positive `credentialSync.formatVersion` when their credential format can be stored in synced account records. A copied account remains pending on a receiving device until the adapter also declares a non-empty `multiDevice.evidenceId` matching the account's plugin version and format version.

The evidence identifier records the adapter's compatibility assertion for copied access-token use, refresh rotation, concurrency, login effects, device-bound fields, and independent detachment. The host still validates the credential schema separately. Adapters without `credentialSync` remain local-only until updated.

All nine built-in adapters currently declare `formatVersion: 1` only. They have no multi-device claim until a live evidence record matches the exact package version, capability, and format version. A credential string that happens to work after copying does not prove rotation, device portability, revocation behavior, or independent detachment. In particular, independent detachment is never inferred by comparing token strings.

## Live procedure

Run the verifier only with a dedicated, non-production account and an isolated test home. The verifier reads the selected account through the existing SQLite account repository, validates its credential schema, copies it into two temporary local configurations, and removes those configurations before returning. It never prints credentials, account identifiers, or raw remote object identifiers.

```sh
OAUTH_SYNC_TEST_HOME=/path/to/oauth-sync-test-home \
OAUTH_SYNC_TEST_ACCOUNT=1 \
OAUTH_SYNC_PROVIDER_ID=<local-provider-id> \
OAUTH_SYNC_REMOTE_OBJECT_ID=<test-remote-object-id> \
OAUTH_SYNC_UPSTREAM=<provider-under-test> \
  rtk proxy bun scripts/verify-oauth-sync.ts \
    --plugin @aio-proxy/plugin-openai-chatgpt --live
```

The command requires both `--plugin` and `--live`, plus the explicit isolated `OAUTH_SYNC_TEST_HOME`, dedicated-account, provider, and remote-object variables above. The test home must not be the default production home or the `AIO_PROXY_HOME` path. The runner reads the sync binding from that test home, connects through the configured sync backend, and reads the supplied remote object before creating two temporary device homes. Repeat it for each adapter version under test. `OAUTH_SYNC_BACKEND_MODULE` can name an installed backend module when the binding is not the built-in CloudKit backend. `OAUTH_SYNC_EVIDENCE_PATH` can point to a reviewable output location; otherwise the redacted result is written to `docs/testing/evidence/oauth-sync.json`.

The runner records `blocked` when required setup, credentials, the configured backend, or the remote object is unavailable. Once a live check executes, a failed assertion is recorded as `fail`; its artifact contains only a fixed allowlisted failure code. It does not turn deterministic fake-endpoint results into upstream evidence. A refresh-capable adapter records rotation as `blocked` until the live exchange, concurrent refresh, interruption, and journal recovery checks pass. OpenRouter and Muse have explicit non-rotating checks and record rotation as `not-applicable`. Copied use is exercised from both isolated configurations, while device binding remains `blocked` because the current adapter context has no device identity or provider-specific portability hook. The current adapter contract also has no independent candidate authorization or upstream revocation hook, so those checks remain `blocked` until a live provider-specific path is supplied.

The six evidence checks are:

| Check               | Required for `multiDevice` | Meaning                                                                                                                     |
| ------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `copiedUse`         | pass                       | The copied credential works on the first isolated configuration.                                                            |
| `rotation`          | pass or `not-applicable`   | Refresh rotation and reuse behavior are verified, or the adapter has no refresh function.                                   |
| `uncertainRecovery` | pass                       | An interruption after exchange recovers through the journaled result.                                                       |
| `deviceBinding`     | pass                       | A provider-specific device portability check proves that device-bound credentials can be copied.                            |
| `loginEffects`      | pass                       | Login and upstream revocation effects are exercised by a provider-specific live path.                                       |
| `independentDetach` | optional                   | A provider-specific candidate authorization proves detachment; it is evaluated only after every `multiDevice` check passes. |

The evidence artifact contains the exact plugin version, capability, format version, timestamps, statuses, evaluation, and redaction markers. It intentionally contains no credentials or account identifiers. A blocked or failed result keeps the adapter pending activation; it must not be converted into `multiDevice.evidenceId` or `canDetach` metadata by hand.

From `packages/server`, the deterministic server acceptance check is separate
from the live adapter gate:

```sh
rtk proxy bun test --preload=./__tests__/setup.ts \
  src/sync-control-plane/acceptance.test.ts
```

OAuth release evidence remains blocked when the isolated test home, dedicated
account, configured backend, or provider-specific upstream proof is unavailable.
In particular, the acceptance fixture does not prove copied-token use,
refresh-rotation recovery, device portability, revocation effects, or independent
detachment for any real adapter.
