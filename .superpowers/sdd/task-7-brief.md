### Task 7: Split CLI Plugin Commands and Colocate Their Tests

**Files:**
- Replace `packages/cli/src/plugin-commands/plugin.ts` with `packages/cli/src/plugin-commands/plugin/`.
- Replace `packages/cli/src/plugin-commands/provider-login.ts` with `packages/cli/src/plugin-commands/provider-login/`.
- Replace `packages/cli/src/plugin-commands/loopback.ts` with `packages/cli/src/plugin-commands/loopback/`.
- Replace `packages/cli/src/plugin-commands/form.ts` with `packages/cli/src/plugin-commands/form/`.
- Split and move tests from `packages/cli/_test/plugin-commands.test.ts`, `provider-plugin-login.test.ts`, `plugin-authorization.test.ts`, and `plugin-form.test.ts`.

**Interfaces:**
- Preserves all imports through `plugin-commands/plugin`, `provider-login`, `loopback`, and `form`.
- Preserves CLI errors included in `pluginErrors`, the existing provider-login error classes and
  `isProviderLoginUserError` safe-error provenance behavior, and loopback user-error classification.

- [ ] **Step 1: Run the CLI baseline**

```bash
rtk bun test packages/cli/_test/plugin-commands.test.ts packages/cli/_test/provider-plugin-login.test.ts packages/cli/_test/plugin-authorization.test.ts packages/cli/_test/plugin-form.test.ts
```

Expected: PASS.

- [ ] **Step 2: Split plugin lifecycle commands**

Create:

```text
plugin/index.ts
plugin/errors.ts
plugin/config-entry.ts
plugin/descriptor.ts
plugin/deps.ts
plugin/add.ts
plugin/configure.ts
plugin/remove.ts
```

Responsibilities:

- `errors.ts`: current plugin lifecycle errors and `pluginErrors`.
- `config-entry.ts`: entry parsing/replacement/removal and JSON comparison.
- `descriptor.ts`: descriptor import, staging, setup validation, and secret compensation.
- `deps.ts`: dependency type, default dependency construction, confirmation helpers.
- `add.ts`: `pluginAdd`.
- `configure.ts`: `pluginConfig`.
- `remove.ts`: `pluginList`, `pluginRemove`, and `pluginPrune`.
- `index.ts`: re-export public options, deps, errors, confirmation helpers, and commands.

- [ ] **Step 3: Split provider login**

Create:

```text
provider-login/index.ts
provider-login/errors.ts
provider-login/capability.ts
provider-login/deps.ts
provider-login/presentation.ts
```

Keep capability parsing/selection in `capability.ts`, dependency construction in `deps.ts`, safe error rendering in `presentation.ts`, and only `providerLogin` orchestration plus exports in `index.ts`.

- [ ] **Step 4: Split loopback and form helpers**

Create:

```text
loopback/index.ts
loopback/errors.ts
loopback/callback.ts
form/index.ts
form/errors.ts
form/json.ts
```

- `loopback/callback.ts`: request validation, redirect URI construction, callback parsing.
- `loopback/index.ts`: Bun listener lifecycle and `runLoopbackAuthorization`.
- `form/json.ts`: inert JSON validation/cloning/equality and compatible defaults.
- `form/index.ts`: prompt traversal and `renderConfigSpec`.

- [ ] **Step 5: Colocate tests by command/concern**

Create files at most 300 lines:

```text
plugin/add.test.ts
plugin/configure.test.ts
plugin/remove.test.ts
plugin/descriptor-security.test.ts
provider-login/capability.test.ts
provider-login/presentation.test.ts
provider-login/login.test.ts
loopback/device-code.test.ts
loopback/callback.test.ts
loopback/server.test.ts
form/render.test.ts
form/secrets.test.ts
form/json.test.ts
```

Keep shared dependency builders in a directory-local `test-support.ts`. Do not create a repository-wide test utility.

- [ ] **Step 6: Verify CLI behavior and binary compilation**

```bash
rtk bun run --filter @aio-proxy/cli test:unit
rtk bun run --filter @aio-proxy/cli build:binary
rtk proxy sh -c 'find packages/cli/src/plugin-commands -name "*.ts" -exec wc -l {} +'
```

Expected: all CLI tests pass, the binary builds, and all files are at most 300 lines.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/cli/src/plugin-commands packages/cli/_test
rtk git commit -m "refactor(cli): split plugin command responsibilities" -m "Co-authored-by: Codex <noreply@openai.com>"
```
