# Dashboard Agents Page — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-26-dashboard-agents-design.md`
**Plan file to commit:** `docs/superpowers/plans/2026-09-26-dashboard-agents.md` (copy of this plan, first commit of the implementation)
**Branch:** `claude/kind-gates-7ik740`

## Context

Agent integrations (`opencode`, `pi`, `omp`, `grok`, `codex`) can only be configured through `aio-proxy agent …` in the CLI. The dashboard only has the device-code approval page at `/agents/authorize`. The user wants an Agents menu with list and detail pages, **and** local one-click configure/repair/remove in the same release. The spec settles the design:

- The server defines an `AgentHostPort`; the CLI injects an implementation built on the existing agent code. This follows the `autoUpdate` precedent in `CreateServerOptions`.
- Writes are gated by container detection, a loopback peer, and same-origin.
- Configure and remove run as polled in-memory operations, because Codex `command` mode blocks on a device approval.
- Codex uses a plan → form → commit flow.

## Key facts from exploration (reuse, don't rebuild)

- `createServer` options: `packages/server/src/server/server.ts:26`. `autoUpdate` is the precedent for a CLI-injected capability. The CLI calls it via `bootProxyServer` in `packages/cli/src/run/run.ts:214`, which is also the path the Docker `CMD ["run", …]` takes.
- Route mounting: `packages/server/src/server/create-routes.ts:286-327`.
  - `/dashboard/api/*` already applies `requireLoopbackHost`, session refresh, dashboard auth, and (when auth is off) `requireLoopbackSameOrigin`.
  - A peer-address loopback check exists as `isDashboardLoopbackRequest` / `requireDashboardLoopback` in `packages/server/src/dashboard-auth/routes.ts:76-84`.
  - The Origin/`Sec-Fetch-Site` check is `requireAgentApprovalOrigin` in `packages/server/src/agent-authorization/routes.ts` (~line 95).
  - Installations and revoke come from `identity.listInstallations()` / `identity.revokeInstallation()`, as used by `createAgentAdminRoutes`.
- Device challenges live in `packages/server/src/agent-authorization/device-challenges.ts`. The `byInstallation` map is keyed by `clientId\0installationId`; `approve`/`deny(deviceId, source)` already exist.
- CLI agent entry points are in `packages/cli/src/agent/agent.ts`: `agentConfigure`, `agentRemove`, `commandDeps`, and `requireDetectedHost`.
  - `agentList` (`list.ts:160`) with `check:false` returns local state without calling the server over HTTP.
- Codex (`packages/cli/src/agent/codex/codex.ts:214`): `configureCodexAgent` requires a TTY and drives `runCodexWizard` (`wizard/wizard.ts`) through `CodexPrompts`.
  - Commit happens through `commitCodexSetup(selection, authContext(...))`, whose `onDevice` callback (`codex.ts:183`) currently prints the user code.
  - Related functions: `inspectCodexConfig`, `occupiedIds`, `inspectProxyKeys(createCredentialDeps(endpoint))`, `inspectCodexSessions`, `migrateCodexSessions`, `restoreCodexMigration`, `recoverPendingCodexOperations`, and `readAuthOperation` (setup journal).
  - `removeCodexAgent` and `listCodexAgent` are exported.
- Endpoint and loopback rules: `resolveAgentEndpoint` / `connectHost` in `packages/cli/src/agent/control-plane/control-plane.ts`.
- Dashboard patterns:
  - Service with `dashboardClient` + `requireOk`: `src/modules/agent-authorizations/services/agent-authorizations-service/`.
  - Route file: `src/routes/agents/authorize.tsx`.
  - Menu: `src/components/side-menu/side-menu.tsx` (the Configuration group).
  - i18n: `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json`.
  - Tests use rstest.

## Tasks

### 1. Shared contracts: `@aio-proxy/types`

New `packages/types/src/agent-integration/dashboard/` (`index.ts`, `dashboard.ts`, `dashboard.test.ts`), re-exported from the agent-integration barrel:

- **Descriptor table:** `AgentDescriptor` plus `AGENT_DESCRIPTORS: Record<AgentTarget, AgentDescriptor>`, holding `integrationKind`, `catalog`, `configureCommand`, `loginCommand?`, and `platformSupport?`.
- **Zod wire schemas:**
  - `AgentLocalStateSchema`: per-target `host` (detected, version?), `state` (`not_installed | not_configured | configured | modified | missing | recovery_required`), `configPath?`, `installationId?`, `adapterVersion?`, `endpointMatches?`, and the Codex `authMode?` / `providerId?`.
  - `AgentsSnapshotSchema`: `descriptors`, `localSetup` (`available | remote_request | unavailable`), `deviceAuthorization`, `installations`, and `local?`.
  - Operations: `AgentOperationStateSchema` (running / awaiting_approval / succeeded / failed) and `AgentOperationErrorCodeSchema`, the closed set from the spec plus `plan_stale` and `recovery_required`.
  - Results: `AgentConfigureResultDtoSchema` and `AgentRemoveResultDtoSchema`, flattened DTOs with no tokens.
  - Codex: `CodexSetupPlanSchema` and `CodexConfigureInputSchema`, the latter a discriminated `auth` union with `migrateFrom` and `planToken`.
  - `AgentOperationRequestSchema`: `{ kind:'configure', target, codex? } | { kind:'remove', target }`.
- **Test:** a schema test that DTO results reject token-shaped fields. This is a public contract; no literal restatement.

### 2. Server: port, operations, routes (`@aio-proxy/server`)

New `packages/server/src/agent-dashboard/`:

- **`host-port.ts`:** the `AgentHostPort` type.
  - Methods: `inspect()`, `configure(req, events)`, `remove(target)`, `codexPlan()`, `codexRestoreMigration(opId)`.
  - `events.onDevice({ installationId, userCode, expiresAt })` lets an operation enter `awaiting_approval`; `events.signal` supports cancel.
- **`operations.ts`:** an in-memory registry.
  - One active operation per target; otherwise it throws a `busy` error that maps to 409.
  - States follow the schema. A finished entry expires after 10 min, checked lazily on access with an injected `now`.
  - An AbortController per operation backs cancel.
  - Errors are mapped to the closed code set; unknown errors are logged through the server logger and reported as `unknown`.
- **`routes.ts`:** `createAgentDashboardRoutes({ host?, identity, challenges, currentConfig, logger })`.
  - Reads: `GET /` (snapshot) and `GET /operations/:id`.
  - Starting operations: `POST /operations` and `POST /codex/restore-migration`.
  - Operation control: `POST /operations/:id/approve|deny|cancel`.
  - Revoke: `POST /:installationId/revoke`.
  - Codex and pending lookups: `GET /codex/plan` and `GET /installations/:installationId/pending`.
  - Gating middleware:
    - A local guard (`host !== undefined && isDashboardLoopbackRequest`) on every port and approval route; otherwise `404`.
    - `requireAgentApprovalOrigin` on non-GET routes, exported from `agent-authorization/routes.ts`.
    - Revoke also requires loopback.
  - `localSetup` is computed per request: port absent → `unavailable`; port present but peer not loopback → `remote_request`; otherwise `available`.
  - Operation approve looks up the pending challenge by the operation's installationId, then calls `challenges.approve(deviceId, requestPeer)`.
  - The pending-lookup route only answers for installationIds present in `host.inspect()` local state.
- **`device-challenges.ts`:** add `pendingForInstallation(target, installationId): AgentAuthorizationDetails | undefined`. It is a read-only lookup through `byInstallation` with `AGENT_CLIENT_ID[target]`, skipping expired entries.
- **`server.ts`:** add `agentHost?: AgentHostPort` to `CreateServerOptions` and thread it to `createRoutes`. Export the port and DTO types from the package index.
- **`create-routes.ts`:** create the routes with the existing `challenges` store and mount them at `.route('/dashboard/api/agents', agentDashboardRoutes)` before `/dashboard/api`, so the typed client sees them.
- **Tests:**
  - `agent-dashboard/routes.test.ts`, using a fake port and Hono `app.request` with peer-address injection, following `agent-authorization/routes.test.ts`, covers:
    - the three `localSetup` modes and the 404 for a remote write;
    - 403 on a cross-origin POST, and 409 on a concurrent same-target operation;
    - the `awaiting_approval` → approve → `succeeded` path, and deny → `authorization_denied`;
    - cancel while waiting;
    - pending lookup refusing an unknown installation;
    - no token strings in any response.
  - `operations.test.ts` covers expiry.
  - `device-challenges.test.ts` adds a case for `pendingForInstallation`.

### 3. CLI: host-port implementation and wiring (`@aio-proxy/cli`)

- **`packages/cli/src/agent/host-port/`** (`index.ts`, `host-port.ts`, `gate.ts`, `host-port.test.ts`, `gate.test.ts`):
  - `shouldEnableAgentHost({ env, resolveEndpoint, home })` returns false when:
    - `AIO_PROXY_AGENT_HOST=disabled`;
    - the resolved endpoint throws (non-loopback);
    - `homedir()` is empty.
  - `createAgentHostPort(deps = commandDeps())` implements each method by delegation:
    - `inspect()` → `agentList({ check:false })`, then maps `targets` + `codex` + `detectHost` into `AgentLocalState`. Pending Codex recovery comes from `readAuthOperation` and maps to `recovery_required`.
    - `configure` for plugin targets and grok → `agentConfigure(target, deps)`, then a DTO map. Its `installationId` comes from a post-configure inspect, since `PluginAgentConfigureResult` doesn't carry it.
    - `configure` for codex → `configureCodexFromDashboard` (below).
    - `remove` → `agentRemove(target, deps)`, then a DTO map.
    - `codexPlan` / `codexRestoreMigration` → the codex module (below).
- **`packages/cli/src/agent/codex/dashboard-setup/`** (`index.ts`, `dashboard-setup.ts`, `dashboard-setup.test.ts`). This keeps `codex.ts` under 400 lines.
  - `buildCodexSetupPlan(location, endpoint)`:
    - Reuses `inspectCodexConfig`, `occupiedIds`, `inspectProxyKeys` (only `{id,label}` is exposed), and `inspectCodexSessions`.
    - Reads the last migration op id from the existing migration journal, if one exists.
    - `planToken` = SHA-256 over the inspection status, provider/auth, occupied ids, key ids, and session target ids + revisions, via `Bun.CryptoHasher`.
  - `configureCodexFromDashboard(input, events)`:
    - Rejects with `recovery_required` if `readAuthOperation` or config recovery is pending; the user resolves it with the CLI.
    - Rebuilds the plan and rejects with `plan_stale` on a token mismatch.
    - Then calls `runCodexWizard` with `isTTY:true` and a **preset `CodexPrompts`** built from the input. The prompts return the submitted providerId, authMode, and key selection, `sources` returns `migrateFrom`, and `migrate` returns `migrateFrom.length > 0`. This reuses all of the wizard's validation, commit, and migration logic unchanged.
    - `commitSetup` uses `commitCodexSetup` with an `authContext` whose `onDevice` forwards to `events.onDevice` and whose signal combines `events.signal`. To allow that, change `authContext` in `codex.ts` to accept optional `onDevice`/`signal` overrides; the CLI defaults stay the same.
  - `restoreCodexMigrationFromDashboard(opId)` wraps the existing restore branch of `configureCodexAgent`. Extract that branch into a small exported function so both callers share it.
- **Wiring:** in `run/run.ts`, pass `agentHost: (await shouldEnableAgentHost(...)) ? createAgentHostPort() : undefined` to `bootProxyServer`.
- **Dockerfile:** add `ENV AIO_PROXY_AGENT_HOST=disabled`.
- **Tests:**
  - The gate conditions.
  - The Codex preset flow with injected fakes: stale token → `plan_stale`; occupied id rejected; only selected source groups migrated; `onDevice` forwarded.
  - A port-mapping test for `inspect` (a modified grok → `modified`, a missing host → `not_installed`).

### 4. Dashboard: `agents` module, routes, menu (`@aio-proxy/dashboard`)

- **Module `src/modules/agents/`:**
  - `services/agents-service/`: typed-client calls and query options (`agentsSnapshotQueryOptions`, `agentOperationQueryOptions(id)` with `refetchInterval` while `running|awaiting_approval`, `codexPlanQueryOptions`, `pendingAuthorizationQueryOptions(installationId)`), plus mutations for start operation, approve/deny/cancel, revoke, and restore.
  - `hooks/`: `use-agent-operation` (start + poll + invalidate snapshot on finish), `use-codex-setup-form` (TanStack Form + Zod from `CodexConfigureInputSchema`), and `use-installations-table` (TanStack Table).
  - `components/` (one component per file):
    - `agent-card`, `local-setup-banner`, `agent-status-panel`, `agent-primary-action`;
    - `operation-progress` (includes the approval UI with user code);
    - `awaiting-login-panel`, `codex-setup-form`, `codex-auth-summary`;
    - `installations-table`, `remove-agent-dialog`, `manual-commands`, `platform-note`, `catalog-note`.
  - `templates/`: `agents-page` (list) and `agent-detail-page`, which selects sections by `descriptor.integrationKind` per the spec table.
  - `lib/`: `agent-state` for pure mapping (local state + installations → card status, primary action, orphaned flag), with a test.
- **Routes:** `src/routes/agents/index.tsx` and `src/routes/agents/$target.tsx`. The latter validates the param with `AgentTargetSchema`; an unknown target shows not-found. `/agents/authorize` is unchanged.
- **Menu:** add an `agents` item (lucide `Bot`) to the Configuration group in `side-menu.tsx`, `isActive: pathname.startsWith('/agents')`, and extend `side-menu.test.tsx`.
- **i18n:** add `dashboard.agents.*` keys (titles, states, kinds, actions, banners, errors per code, form labels, notes) to all 5 locale files, then run `bun run i18n:compile`. Agent names, commands, and the Provider ID stay literal.
- **Tests (rstest):**
  - `agents-page` renders all three `localSetup` modes, with buttons disabled for `remote_request`.
  - `agent-detail-page` renders the right sections for opencode, grok, and codex.
  - `codex-setup-form` hides the key section for `command` mode and the migration section when there are no groups.
  - `operation-progress` shows Approve and calls the mutation.
  - `lib/agent-state` has a unit test.

### 5. Docs and release

- `docs/agent-grok.md` and the README / README.zh-Hans Agent section: add one line pointing to the dashboard Agents page.
- `bun changeset`: `minor` for `aio-proxy`, `@aio-proxy/cli`, `@aio-proxy/server`, `@aio-proxy/dashboard`, and `@aio-proxy/types`. The note is one short paragraph, with no area prefix.
- Update the spec status to "accepted"; commit this plan under `docs/superpowers/plans/`.

## Verification

1. `bun run check`, plus the unit tests of the affected packages: `bun run --filter @aio-proxy/types test`, and likewise for `server`, `cli`, and `dashboard`, then `i18n`.
2. `bun run build`, then `bun run lint:types` (it needs the built `dist`), then `bun run preflight`.
3. Manual end-to-end with the `run` skill:
   - Start `aio-proxy run` locally with a temp `AIO_PROXY_HOME` and `HOME` pointing at a scratch dir.
   - Open `/dashboard/agents` in Playwright Chromium and check that the snapshot shows `available`.
   - Configure `opencode` with a fake `opencode` binary on `PATH` and confirm the managed files appear under the scratch HOME.
   - Remove it and confirm the files are restored.
   - Configure codex in `command` mode and confirm the operation reaches `awaiting_approval`, Approve succeeds, and `~/.codex/config.toml` contains the provider.
   - Re-run with `AIO_PROXY_AGENT_HOST=disabled` and confirm `unavailable`, no buttons, and commands shown.
   - Request `GET /dashboard/api/agents` with a non-loopback peer, simulated in the route test, and confirm `remote_request`.
4. Commit per task with Conventional Commit messages and push to `claude/kind-gates-7ik740`.
