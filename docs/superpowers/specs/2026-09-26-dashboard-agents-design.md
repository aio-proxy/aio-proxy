# Dashboard Agents page with local one-click setup

Date: 2026-09-26
Status: accepted

## Goal

Give Agent integrations a first-class place in the dashboard. Today `aio-proxy agent list|configure|remove|revoke` exist only in the CLI, and the dashboard only hosts the device-approval page at `/agents/authorize`.

This change adds an **Agents** menu entry with a list page and a per-Agent detail page. When the dashboard is opened on the same machine as a non-containerized aio-proxy, the user can configure, repair, and remove each supported Agent with one click. When that is not possible, the same pages show read-only server-side state and copyable CLI commands instead.

The CLI keeps working unchanged. The dashboard reuses the CLI's existing configure/inspect/remove implementations; it does not reimplement Agent file editing.

## Non-goals

- Writing Agent files on a machine other than the one running aio-proxy. A remote browser never gets file-write capability.
- Changing the Agent OAuth/device protocol, token formats, catalog schema, or the managed-marker formats.
- Adding new Agent targets. The descriptor table below makes that cheaper later.
- Guessing which OS user "should" own the Agent config when aio-proxy runs as a service. The dashboard shows the resolved paths and the user verifies them.

## Supported Agents and integration kinds

The five `AgentTarget` values fall into three integration kinds. UI and API branch on the kind, not the target name.

| Kind | Targets | configure does | Login after configure |
| --- | --- | --- | --- |
| `plugin` | `opencode`, `pi`, `omp` | Installs/updates the managed provider plugin files; catalog synced from aio-proxy | `opencode auth login --provider aio-proxy` or `/login aio-proxy` in the Agent, then device approval |
| `auth-command` | `grok` | Writes the managed Grok config fields and helper command | `grok login`, then device approval |
| `static-config` | `codex` | Writes a provider into `config.toml`; picks an auth mode; optionally migrates sessions | `command` mode: device approval happens during configure. `keep-chatgpt` mode: none |

### Descriptor table

Add `AgentDescriptor` in `@aio-proxy/types` (next to `agent-integration`), keyed by `AgentTarget`, and use it from both the CLI output and the dashboard:

```ts
type AgentDescriptor = {
  readonly target: AgentTarget;
  readonly integrationKind: 'plugin' | 'auth-command' | 'static-config';
  readonly catalog: 'synced' | 'host_managed';
  readonly configureCommand: string;   // e.g. 'aio-proxy agent configure opencode'
  readonly loginCommand?: string;      // absent for codex
  readonly platformSupport?: 'verified' | 'macos_only_verified';
};
```

User-facing text (names aside) comes from i18n keys derived from the target and kind; the descriptor carries no prose.

## Architecture

### Where the code runs

`createServer` is always called by the CLI (`aio-proxy run`, the service unit, and the Docker entrypoint all go through `bootProxyServer`). `@aio-proxy/cli` already depends on `@aio-proxy/server`, so the server defines a port and the CLI injects an implementation:

```ts
// @aio-proxy/server
export interface AgentHostPort {
  readonly inspect: () => Promise<AgentLocalSnapshot>;
  readonly configure: (request: AgentConfigureRequest, events: AgentOperationEvents) => Promise<AgentConfigureResult>;
  readonly remove: (target: AgentTarget) => Promise<AgentRemoveResult>;
  readonly codexPlan: () => Promise<CodexSetupPlan>;
  readonly codexRestoreMigration: (operationId: string) => Promise<AgentConfigureResult>;
}

createServer({ ..., agentHost?: AgentHostPort });
```

- The server package never touches Agent files and never imports CLI code.
- The CLI implementation in `packages/cli/src/agent/host-port/` wraps the existing `agentConfigure`, `agentList`, `agentRemove`, the Codex setup commit, and the migration restore. It must reuse the existing installation locks, managed markers, setup journals, and field restoration. No second write path exists.
- Result types that the dashboard renders (`AgentConfigureResult`, `AgentRemoveResult`, the local list entry, `CodexSetupPlan`) move into `@aio-proxy/types` as Zod schemas so the typed Hono client carries them. CLI rendering keeps consuming the same types.

### Availability gate

The snapshot exposes `localSetup`:

| Value | Meaning | UI |
| --- | --- | --- |
| `available` | Port injected and this request is from loopback | Action buttons enabled |
| `remote_request` | Port injected but the browser is not on loopback | Buttons disabled with an explanation; commands shown |
| `unavailable` | Port not injected | Commands shown; no local state |

The CLI injects the port only when all of these hold:

1. aio-proxy is not running in a container. The Dockerfile sets `AIO_PROXY_AGENT_HOST=disabled`. Users can set the same variable to opt out anywhere.
2. The resolved Agent endpoint is loopback. This check reuses `resolveAgentEndpoint`/`connectHost`, so `--host 0.0.0.0` still resolves to `127.0.0.1`.
3. A home directory is resolvable for the server process.

### Security

Every route that calls the port:

- requires an authenticated dashboard session (existing dashboard auth);
- requires a loopback peer (`isDashboardLoopbackRequest`);
- requires same-origin, reusing the `Origin`/`Sec-Fetch-Site` check from the agent approval routes, for every non-GET request;
- validates `target` against `AgentTargetSchema` and the Codex selection against its schema;
- runs at most one operation per target at a time. A second request gets `409 { error: 'operation_in_progress' }`. Concurrent CLI runs are still serialized by the existing installation locks, which surface as a structured `locked` error.

Responses never include access or refresh tokens, and never include the bearer token read from Codex config. Codex key choices expose only `{ id, label }`, as the CLI prompt does.

## API

All routes live under `/dashboard/api/agents`, are registered in `create-routes.ts`, and are consumed through `createDashboardClient`.

| Method and path | Gate | Purpose |
| --- | --- | --- |
| `GET /` | dashboard auth | Snapshot: descriptors, `localSetup`, `deviceAuthorization`, server installations; plus local per-target state when `available` |
| `POST /:installationId/revoke` | auth + loopback + origin | Revoke, same semantics as `/admin/agent-installations/:id/revoke` |
| `POST /operations` | auth + loopback + origin | Start `configure` or `remove` for a target; returns `{ operationId }` |
| `GET /operations/:operationId` | auth + loopback | Operation state (below) |
| `POST /operations/:operationId/approve` | auth + loopback + origin | Approve the device challenge bound to this operation |
| `POST /operations/:operationId/cancel` | auth + loopback + origin | Cancel an operation that is still waiting for approval |
| `GET /codex/plan` | auth + loopback | Inputs for the Codex form |
| `GET /installations/:installationId/pending` | auth + loopback | Pending device challenge for a known installation, if any |
| `POST /codex/restore-migration` | auth + loopback + origin | `{ operationId }` from a previous migration |

The existing `/admin/agent-installations` routes stay as they are for the CLI.

### Operations

Configure can outlive one HTTP request: Codex `command` mode runs a device authorization inside the setup commit and waits up to the challenge's 600 s. Configure and remove therefore run as in-memory operations:

```ts
type AgentOperationState =
  | { status: 'running'; target: AgentTarget; kind: 'configure' | 'remove' }
  | { status: 'awaiting_approval'; target: AgentTarget; deviceId: string; userCode: string; expiresAt: string }
  | { status: 'succeeded'; target: AgentTarget; result: AgentConfigureResult | AgentRemoveResult }
  | { status: 'failed'; target: AgentTarget; error: AgentOperationError };
```

- The dashboard polls `GET /operations/:id` with TanStack Query while the status is `running` or `awaiting_approval`.
- `awaiting_approval` is entered through the existing `onDevice` callback of the Codex setup. The dashboard shows the user code for comparison and a single **Approve** / **Deny** pair. Approval calls the existing challenge store with the same audit source as the authorize page. The dashboard never auto-approves: clicking Configure is not treated as approving a device.
- Operations are kept for 10 minutes after they finish, then dropped. They are not persisted. After a restart, the existing Codex setup journal handles recovery exactly as it does after an interrupted CLI run. The next snapshot reports `recovery_required` for that target.
- `AgentOperationError` is a closed code set (`host_missing`, `path_unavailable`, `not_configured`, `locked`, `invalid_provider_id`, `occupied_provider_id`, `endpoint_changed`, `authorization_denied`, `authorization_expired`, `recovery_required`, `plan_stale`, `cancelled`, `unknown`) mapped from the errors the CLI implementations already throw. Only `unknown` carries a server-logged detail.

### Login approval for plugin and Grok targets

For `plugin` and `auth-command` targets, configure finishes immediately and returns the `installationId`. The detail page then enters a **waiting for login** state:

- It shows the login command.
- It polls `GET /installations/:installationId/pending`.
- When the Agent's login creates a device challenge for that installation, the page shows the target, adapter version, and user code with Approve / Deny.

The lookup only matches challenges whose `installation_id` equals an installation from the local snapshot. The code-entry page `/agents/authorize` stays for CLI-initiated flows and remote browsers.

## Codex form

`runCodexWizard` already separates prompting from committing (`CodexPrompts` vs. `commitSetup(selection)` and `migrateSessions`). The dashboard path reuses the same validation and commit functions with a non-TTY driver:

`GET /codex/plan` returns:

```ts
type CodexSetupPlan = {
  configPath: string;
  inspection: { status: 'absent' | 'managed' | 'modified' | 'conflict'; providerId?: string; authMode?: CodexAuthMode };
  defaultProviderId: string;           // inspection.providerId ?? 'aio-proxy'
  occupiedProviderIds: string[];
  keyChoices: { id: string; label: string }[];
  sessions: { groups: SessionGroup[]; blocked: number };
  lastMigrationOperationId?: string;   // enables "Restore migration"
};
```

The configure request for Codex carries:

```ts
type CodexConfigureInput = {
  providerId: string;
  auth: { mode: 'keep-chatgpt'; key: KeySelection } | { mode: 'command' };
  migrateFrom: string[];               // provider IDs; empty = do not migrate
  planToken: string;                   // hash of the plan; rejects if config or sessions changed since
};
```

- The server re-inspects, re-validates the provider ID against occupied IDs, and resolves the key through `KeySnapshot.resolve`. It computes migration targets from `migrateFrom` against a fresh preview and rejects with `plan_stale` if `planToken` no longer matches.
- The form uses TanStack Form in four sections on one page: Provider ID → Auth mode → Key (only for `keep-chatgpt` with choices) → Session migration (only when groups other than the chosen provider exist, with active/archived counts and an explicit confirm checkbox).
- `inspection.status === 'conflict'` blocks submit and tells the user to resolve it with the CLI, the same outcome the CLI reaches.

## Dashboard

### Menu and routes

- A new **Agents** item in the Configuration group, icon from lucide, route `/agents`.
- `/agents/$target` is the detail page. `/agents/authorize` stays as it is.
- The module is `src/modules/agents/` (`services`, `hooks`, `components`, `templates`, `lib`). The existing `agent-authorizations` module stays separate. Any shared piece (for example the user-code display) moves to `src/lib/` rather than being imported across modules.

### List page

- A banner when `deviceAuthorization === 'password_required'`, linking to Settings.
- A banner explaining `remote_request` or `unavailable` when not `available`.
- One card per descriptor:
  - name and icon, integration-kind badge;
  - local state (`not_installed` when the host binary is missing; otherwise `not_configured`, `configured`, `modified`, `missing`, `recovery_required`);
  - server authorization summary (active / expired / revoked counts);
  - one primary action: Configure, Update (adapter version newer than installed), or Repair (modified/missing).

### Detail page

The page is assembled from sections selected by `integrationKind`:

| Section | plugin | auth-command | static-config |
| --- | --- | --- | --- |
| Status: local state, resolved config path, host version, endpoint match | ✓ | ✓ | ✓ |
| Primary action + operation progress / approval panel | ✓ | ✓ | ✓ (opens Codex form) |
| Waiting-for-login panel | ✓ | ✓ | — |
| Catalog note (synced vs host-managed) | ✓ | ✓ | — |
| Platform note (`GROK_HOME`, verified platforms) | — | ✓ | — |
| Auth mode summary + restore migration | — | — | ✓ |
| Installations table (TanStack Table): ID, adapter version, created, last authorized, status, Revoke; rows with no local match marked `orphaned` | ✓ | ✓ | ✓ |
| Remove (confirm dialog; result shows revoke status, skipped fields, retained files) | ✓ | ✓ | ✓ |
| Manual CLI commands (collapsed; expanded by default when not `available`) | ✓ | ✓ | ✓ |

Codex in `keep-chatgpt` mode creates no installation. Its status comes from local state only, and the installations table says so instead of appearing empty.

## Testing

Unit and route tests, colocated with the code they cover:

- **Gate:** the port is not injected when `AIO_PROXY_AGENT_HOST=disabled`; write routes return 404 from a non-loopback peer and 403 on a cross-origin request; the snapshot reports `remote_request` correctly.
- **Operations:** a concurrent operation on the same target returns 409. A Codex `command` configure reaches `awaiting_approval`, succeeds after approve, and fails with `authorization_denied` after deny. Cancel works while waiting.
- **Codex:** `plan_stale` rejects a request after config changes; an occupied provider ID is rejected; migration only includes the selected source groups; no token appears in plan or result payloads.
- **Pending lookup:** it does not return challenges for installation IDs outside the local snapshot.
- **CLI:** the host port delegates to the same functions as `agent configure|remove`. Existing `agent.test.ts` and `output.test.ts` stay green.
- **Dashboard:** the list renders the three local-setup modes. The detail page renders the right sections per kind. The Codex form hides the key and migration sections when not applicable.

## Rollout and release

- One changeset, `minor`, targeting `aio-proxy`, `@aio-proxy/cli`, `@aio-proxy/server`, `@aio-proxy/dashboard`, and `@aio-proxy/types`. The note: Agents can now be viewed, configured, repaired, removed, and approved from a new dashboard page when aio-proxy runs locally.
- i18n keys for all supported locales, then `bun run i18n:compile`.
- `docs/agent-grok.md` and the README Agent section gain a short "or use the dashboard Agents page" line.

## Open questions

- Should `installationId` rows also record a host label (hostname) at device-approval time, so multiple installations of one target are distinguishable? It is not required for this change, and it would add a field to `AgentInstallationSummary`.
