# Task 1 report: native Codex command-auth contract probe

## Scope and files

Implemented only the Task 1 command-auth experiment and contract report update. The existing design spec, implementation plan, historical fixtures, and production authentication code were left unchanged.

- `packages/cli/scripts/verify-codex-command-auth.ts`
  - Exports `CommandAuthProbe` and `verifyCodexCommandAuth(executable)`.
  - Accepts only the explicitly supplied Codex executable.
  - Uses temporary `HOME`, `CODEX_HOME`, and `TMPDIR` roots, a loopback upstream, and helper paths containing spaces.
  - Uses `Bun.spawn` argument arrays, empty stdin, and the exact synthetic raw helper token.
  - Exercises raw, JSON, empty, non-zero, and over-5-second helper outcomes.
  - Runs isolated app-server JSON-RPC `account/read` and model-request checks, kills timed-out children, and removes the temporary root.
  - Emits only the typed boolean/version/platform result on stdout; failure diagnostics are sanitized before stderr output.
- `docs/superpowers/specs/2026-09-09-codex-contract-verification.md`
  - Adds the Task 1 native command-auth section and the observed machine-readable result.
  - Distinguishes the new command experiment from the existing static/migration experiment.
- `.superpowers/sdd/2026-09-09-codex-agent-configure/task-1-report.md`
  - This report.

## Verification

Commands run:

```text
rtk bunx oxfmt packages/cli/scripts/verify-codex-command-auth.ts
rtk bunx oxlint packages/cli/scripts/verify-codex-command-auth.ts
rtk proxy bun packages/cli/scripts/verify-codex-command-auth.ts /opt/homebrew/bin/codex
```

The formatter and linter passed. The isolated probe ran against `codex-cli 0.146.0` on `darwin/arm64` and returned:

```json
{
  "version": "codex-cli 0.146.0",
  "platform": "darwin/arm64",
  "rawTokenAccepted": false,
  "incompatibleConfigRejected": true,
  "refreshAfter401": false,
  "proactiveRefresh": false,
  "staticAccountType": null,
  "commandAccountType": null,
  "authFilesUnchanged": true
}
```

The CLI assertion gate failed on the first required positive condition (`rawTokenAccepted`). This is intentional evidence from the required gate, not a successful command-auth verification.

## Exact commit

The implementation commit is:

`e56e8d595`

Commit message:

`test(cli): verify Codex command authentication contract`

The commit includes the required footer:

`Co-authored-by: Codex <noreply@openai.com>`

This report was committed in the follow-up report-only commit returned with the task status.

## Concerns

- `codex-cli 0.146.0` rejected the incompatible `auth` plus `requires_openai_auth = true` combination as expected.
- Both the command-auth and static app-server sessions timed out during `initialize`, so `account/read`, raw bearer use, 401 helper retry, and proactive refresh could not be observed. The report records these as unverified/false and does not wire production command authentication around them.
- The helper input observations were sanitized: JSON and empty output exited 0, non-zero output exited 7, and the timeout exceeded the 5-second limit. No raw token, Authorization header, or user credential was recorded.
- The assertion gate therefore fails on the host result. No minimum supported Codex version is inferred, and no Computer Use, plugin, or real AIO Proxy compatibility claim is made.

## Round 1 fixes

The reviewer findings were addressed in the probe and runtime split:

- JSON-RPC stdin and stdout framing now uses actual newline delimiters.
- Authorization values are reduced to boolean matches; no header string is retained in arrays, diagnostics, or the result.
- Raw, JSON, empty, non-zero, and timeout helpers now run through separate Codex command-auth configurations. The loopback model path records request counts and helper invocation counts only.
- Incompatible configuration reports `rejected` only when bounded startup emits a configuration diagnostic; generic timeout or process failure is not treated as rejection.
- The 401 check requires two requests, raw then refreshed bearer matches, and at least two helper invocations. Proactive refresh runs in a separate session with a 100 ms experimental interval.
- A shared 45-second deadline tracks and kills spawned app-server processes. Synthetic auth files are snapshotted, and `authFilesUnchanged` is false when any required experiment cannot complete.

Round 1 fix verification:

```text
rtk bunx oxfmt packages/cli/scripts/verify-codex-command-auth.ts packages/cli/scripts/codex-command-auth-runtime.ts
rtk bunx oxlint packages/cli/scripts/verify-codex-command-auth.ts packages/cli/scripts/codex-command-auth-runtime.ts
rtk proxy bun packages/cli/scripts/verify-codex-command-auth.ts /opt/homebrew/bin/codex
```

Formatter and lint passed. The host probe passed its assertion gate on `codex-cli 0.146.0` / `darwin/arm64` with `rawTokenAccepted=true`, `incompatibleConfigRejected=true`, `refreshAfter401=true`, `proactiveRefresh=true`, `staticAccountType="chatgpt"`, `commandAccountType=null`, and `authFilesUnchanged=true`. Sanitized diagnostics recorded two requests and two helper invocations for the 401 path; malformed helper cases ran through Codex configuration with invocation counts 3, 10, 10, and 2 for JSON, empty, non-zero, and timeout modes respectively.

Fix commits:

- `04da909` — implementation and runtime split, with `Co-authored-by: Codex <noreply@openai.com>`.
- The report update is committed in the follow-up report commit returned with the task status, with the same required footer.

Round 1 concerns: the result is still an isolated host contract experiment against version `0.146.0`; it does not establish a minimum supported version or compatibility for Computer Use, plugins, or the real AIO Proxy service. The malformed helper outcomes are observed host behavior and are not treated as bearer-protocol success.
