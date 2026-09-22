# Agent Model Protocol Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize model-family ingress-protocol classification in agent-provider runtime and make Pi and OMP consume that one rule.

**Architecture:** Add one pure runtime resolver that maps a catalog model ID to the proxy protocol the corresponding native client API uses. Pi-family catalog projection imports the resolver and retains only its host-specific Gemini base-URL rule; no catalog schema, installation state, or CLI option changes.

**Tech Stack:** TypeScript, Bun test, Bun workspace, existing `@aio-proxy/agent-provider-runtime` and `@aio-proxy/pi-provider` packages.

**Spec:** `docs/superpowers/specs/2026-09-22-agent-model-protocol-routing-design.md`

## Global Constraints

- Keep `AgentCatalogV1` and persisted managed state byte-compatible; protocol classification is local runtime behavior.
- Do not add #398's protocol flag, sidecar preferences, installation fields, or CLI output.
- Do not add dependencies; use the existing package boundaries and Bun test runner.
- Keep the Gemini `/v1beta` URL projection private to the Pi-family adapter.
- Preserve the existing fallback to OpenAI Chat Completions for every model ID outside the three recognized families.

## Review Focus

- `gpt-*` must produce Responses, so the Pi host sends `/v1/responses` rather than Chat Completions.
- `claude-*` must produce Anthropic Messages rather than the fallback protocol.
- `gemini-*` must preserve both Google Generative AI and Pi's `/v1beta` base URL.
- Unknown families, including `grok-*`, must remain on Chat Completions.
- Near matches such as `gpt` and uppercase `GPT-*` must not accidentally select a native protocol.

---

## File Structure

- Create `packages/agent-provider/runtime/src/model-protocol/model-protocol.ts`: pure model-ID classifier and its exported protocol union.
- Create `packages/agent-provider/runtime/src/model-protocol/model-protocol.test.ts`: behavior-level coverage for every recognized family and fallback boundary.
- Create `packages/agent-provider/runtime/src/model-protocol/index.ts`: export-only public entry point for the runtime collaborator.
- Modify `packages/agent-provider/runtime/src/index.ts`: re-export the public classifier.
- Modify `packages/agent-provider/pi/src/core/core.ts`: replace the Pi-private classifier with the runtime classifier; retain Pi-specific URL projection.
- Modify `packages/agent-provider/pi/src/core/core.test.ts`: prove Pi's public catalog projection preserves all protocol and base-URL behavior.

### Task 1: Add the runtime model-protocol classifier

**Files:**

- Create: `packages/agent-provider/runtime/src/model-protocol/model-protocol.ts`
- Create: `packages/agent-provider/runtime/src/model-protocol/model-protocol.test.ts`
- Create: `packages/agent-provider/runtime/src/model-protocol/index.ts`
- Modify: `packages/agent-provider/runtime/src/index.ts`

**Interfaces:**

- Consumes: `modelId: string` from an `AgentCatalogV1` model.
- Produces: `AgentModelProtocol`, the exact union `'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai'`.
- Produces: `resolveAgentModelProtocol(modelId: string): AgentModelProtocol`.

- [ ] **Step 1: Write the failing runtime behavior test**

Create `model-protocol.test.ts` with the public import and these cases:

```ts
import { expect, test } from 'bun:test';

import { resolveAgentModelProtocol } from './model-protocol';

test.each([
  ['gpt-5.6', 'openai-responses'],
  ['claude-opus-5', 'anthropic-messages'],
  ['gemini-3.8-flash', 'google-generative-ai'],
  ['grok-4.5', 'openai-completions'],
  ['gpt', 'openai-completions'],
  ['GPT-5.6', 'openai-completions'],
] as const)('routes %s to %s', (modelId, protocol) => {
  expect(resolveAgentModelProtocol(modelId)).toBe(protocol);
});
```

The test names the regression: deleting a family branch or broadening a prefix match changes the protocol sent by every consuming agent.

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```sh
bun test packages/agent-provider/runtime/src/model-protocol/model-protocol.test.ts
```

Expected: FAIL because `./model-protocol` and `resolveAgentModelProtocol` do not exist yet.

- [ ] **Step 3: Implement the minimal pure classifier**

Create `model-protocol.ts` with this exact public shape:

```ts
export type AgentModelProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export function resolveAgentModelProtocol(modelId: string): AgentModelProtocol {
  if (modelId.startsWith('gpt-')) return 'openai-responses';
  if (modelId.startsWith('claude-')) return 'anthropic-messages';
  if (modelId.startsWith('gemini-')) return 'google-generative-ai';
  return 'openai-completions';
}
```

Make `model-protocol/index.ts` export the type and function, then re-export them from `runtime/src/index.ts`. Do not import `@aio-proxy/types` or add a catalog field.

- [ ] **Step 4: Run the runtime tests and type-aware checks**

Run:

```sh
bun test packages/agent-provider/runtime/src/model-protocol/model-protocol.test.ts
bun run --cwd packages/agent-provider/runtime test:unit
bun run check
```

Expected: all commands exit 0; the new test proves the three native families, unknown-model fallback, and strict lowercase hyphenated prefixes.

- [ ] **Step 5: Commit the runtime change**

```sh
git add packages/agent-provider/runtime/src/index.ts packages/agent-provider/runtime/src/model-protocol
git commit -m "refactor(agent): centralize model protocol routing" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Make Pi and OMP project the runtime decision

**Files:**

- Modify: `packages/agent-provider/pi/src/core/core.ts`
- Modify: `packages/agent-provider/pi/src/core/core.test.ts`

**Interfaces:**

- Consumes: `resolveAgentModelProtocol(model.id)` from Task 1.
- Consumes: `AgentCatalogV1` in `toPiFamilyModels(catalog, endpoint)`.
- Produces: Pi/OMP `ProviderModelConfig` entries with the native protocol and, only for Gemini, `baseUrl: '<endpoint>/v1beta'`.

- [ ] **Step 1: Run the existing Pi-family projection tests as the refactor baseline**

The behavior already has public projection coverage in `core.test.ts`: its catalog rows assert the native API selected for GPT, Claude, Gemini, and fallback IDs, including the Gemini `/v1beta` URL. This task is a refactor, not a new behavior, so do not add an implementation-coupled import test.

Run:

```sh
bun test packages/agent-provider/pi/src/core/core.test.ts
```

Expected: PASS before the refactor. Task 1's new runtime test is the failing-test proof for the newly introduced shared collaborator.

- [ ] **Step 2: Replace the Pi-private classifier with the runtime import**

In `core.ts`, import `resolveAgentModelProtocol` from `@aio-proxy/agent-provider-runtime`, delete `apiForModel`, and assign:

```ts
const api = resolveAgentModelProtocol(model.id);
```

Leave the `api === 'google-generative-ai'` `/v1beta` URL branch unchanged. Do not alter `official-pi.ts`, `omp.ts`, OAuth, refresh, or catalog persistence: both hosts already consume `toPiFamilyModels`.

- [ ] **Step 3: Verify Pi, OMP, and compatibility behavior**

Run:

```sh
bun test packages/agent-provider/pi/src/core/core.test.ts
bun run --cwd packages/agent-provider/pi test:unit
bun run --cwd packages/agent-provider/pi test:compat
bun run check
```

Expected: all commands exit 0. The compatibility run continues to prove that a GPT model reaches the Responses endpoint while ordinary fallback models remain valid.

- [ ] **Step 4: Commit the Pi-family migration**

```sh
git add packages/agent-provider/pi/src/core/core.ts packages/agent-provider/pi/src/core/core.test.ts
git commit -m "refactor(pi): reuse agent model protocol routing" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Deferred Adapter Plans

OpenCode and Grok deliberately have no implementation task in this plan. Their current host contracts cannot consume a per-model protocol decision without either changing authenticated provider identity (OpenCode) or adding authenticated model-config materialization with owned TOML lifecycle (Grok). A separate design must first pin those mechanisms with a host compatibility test; until then, importing the resolver would be dead code and claiming native routing would be false.

## Self-Review

- Spec coverage: Tasks 1 and 2 cover the shared rule and all currently supported consumers; no catalog, CLI, state, or sidecar behavior is introduced.
- Placeholder scan: no task relies on an unspecified API or a generic “add tests” instruction.
- Type consistency: `AgentModelProtocol` and `resolveAgentModelProtocol` are defined in Task 1 and consumed verbatim in Task 2.
- Review focus: Task 1 exercises all five listed model-ID classes; Task 2 additionally pins the host-visible Gemini URL projection.
