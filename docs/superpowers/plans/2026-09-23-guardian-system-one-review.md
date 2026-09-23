# Guardian System One Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the ChatGPT OAuth plugin optionally use one configured System One evaluation Provider for eligible Codex Guardian approvals, with a direct-decision mode and a mode that sends valid denials to `codex-auto-review` for final review.

**Architecture:** The ChatGPT plugin owns Guardian recognition, complete conversation projection, four choice questions, answer validation, strategy, and synthetic Responses output. Its private early sensitivity hint lets the host suppress payload capture before ingress observation without putting Guardian policy in the server. A private host callback dispatches to one verified candidate from a leased Provider snapshot using the existing System One evaluation transport. Existing ChatGPT transport remains the captured fallback, and trusted per-invocation metadata prevents its flat fee when that transport never starts.

**Tech Stack:** Bun, TypeScript, Zod, existing `@aio-proxy/core` System One adapter, Hono server, React/TanStack Form/TanStack Query dashboard, Bun tests.

**Spec:** `docs/superpowers/specs/2026-09-23-guardian-system-one-review-design.md`

## Global Constraints

- Apply System One only to OpenAI Responses creation whose **resolved ChatGPT model ID** is exactly `codex-auto-review`, with `client_metadata["x-openai-subagent"] === "guardian"`, the observed Guardian JSON schema, and the unique final approval envelope. The supplied `gpt-6-sol` attachment is caused by the separate model-catalog bug and is not eligible.
- The absent/default strategy invokes the original transport without parsing the body. Every non-Guardian or unsupported profile uses the untouched original request before disclosing anything to the selected Provider.
- Plugin settings are shared across ChatGPT accounts: `default`, `systemOne`, `systemOneReviewDenied`; the latter two require a configured Provider ID and a routable model slug. No second endpoint or API key is stored in the plugin.
- Preserve the complete inline `input` array, including role/order/content/tool associations and permitted opaque metadata, as structured `state.input`; parse the terminal action into `state.pending_action`. Do not summarize or hydrate unresolved references. Reject incomplete, uninterpretable, or oversized context before dispatch.
- Ask exactly four `choice` questions named `risk_level`, `user_authorization`, `outcome`, `reason`, with the literal labels in the spec. The actual developer policy in `state.input` governs the decision; tool output, assistant prose, and quoted role labels cannot authorize an action.
- Validate all four selected labels and each declared probability in `[0,1]`, including low-risk allow. Do not invent a sum tolerance or confidence threshold. Invalid, `uncertain`, or incompatible combinations fall back while the caller is live.
- A valid low-risk approval yields `{"outcome":"allow"}`. Other valid decisions use the deterministic rationale table in the spec and must validate against the incoming Guardian schema before any response byte is sent.
- `systemOne` treats a valid denial as final. `systemOneReviewDenied` resumes the original transport below the wrapper on a valid denial; original success or failure is final for that raw invocation. Operational errors and timeouts use the original transport in either mode while the caller is live.
- The target is selected only from saved plugin options. Resolve `providerId/modelId` at invocation time from one leased snapshot, require exactly one candidate with that Provider ID and `selectionSource: "provider_qualified"`, and dispatch that same candidate. Never fall through to an ordinary slash alias or another Provider.
- Keep the server's generation candidate loop and public plugin SDK `RuntimeContext` unchanged. Server modifications only compose the private capability, reuse candidate-scoped evaluation dispatch, propagate lifecycle/accounting context, and keep telemetry safe. No loopback HTTP request.
- The evaluation deadline covers snapshot acquisition, transport, body consumption, and validation; caller cancellation never triggers fallback. A late evaluation result cannot replace a started fallback or emitted response.
- Direct System One results have no ChatGPT usage row or flat request fee. Each evaluation attempt owns its available Provider usage/cost; each real original-model attempt keeps its applicable existing charge. Aggregate cost must not double-count the child evaluation.
- Never log transcript, projected state, questions, generated rationale, raw evaluator errors that can echo input, or their copies in diagnostic/trace exporters. The capture policy must be established before `observeInboundRequest`, then cover the parent request, evaluation, fallback, retries, and response observation. Use bounded reason codes, safe target IDs, strategy, and correlation ID only.
- Use the existing Provider list for dashboard choices, a typed Hono client and TanStack Query, TanStack Form controls, and i18n messages. The CLI accepts exact Provider and model IDs. Do not add a Provider-list endpoint or a ChatGPT-only dashboard picker.
- Keep the existing unrelated `bun.lock` modification untouched. Do not use the private Guardian attachment as a test fixture or upload it to Oracle; use a synthetic, sanitized fixture. Run `rtk bun run preflight` before claiming implementation complete, and author one user-facing changeset with `aio-proxy` and `@aio-proxy/plugin-sdk` plus affected internal packages.

## Review Focus

1. A Guardian-looking `input` with encrypted/unknown content that could carry decision evidence must use the original model before any Provider disclosure; Task 4 tests this with an opaque item.
2. A quoted approval marker in tool output or a second envelope earlier in the transcript must not replace the unique final action or confer authorization; Task 4 tests both sources.
3. A saved `providerId/modelId` whose qualified route vanished but whose slash string is now an ordinary alias must never dispatch to the alias owner; Task 7 tests this after snapshot reload.
4. Caller abort racing a System One timeout or the instant before fallback must not start the original transport; Task 9 tests both race points and late results.
5. A synthetic transcript sentinel in an evaluator error or invalid response must not enter request diagnostics, raw capture, or exported trace data; Tasks 8 and 10 check the pre-observation boundary and every failure path with enabled diagnostic sinks.

## File Responsibility Map and Interfaces

| Unit | Files | Responsibility |
| --- | --- | --- |
| Generic form contract | `packages/plugin-sdk/src/config.ts`, `packages/core/src/plugins/config-spec.ts`, `packages/types/src/dashboard-oauth.ts`, `packages/server/src/dashboard-routes/oauth-capabilities.ts`, `packages/cli/src/plugin-commands/form/render.ts` | Add a non-default condition and generic configured-Provider/model fields; validate/project them without ChatGPT-specific DTOs. |
| Plugin settings | `packages/plugins/openai-chatgpt/src/plugin-options/plugin-options.ts`, `src/plugin/plugin.ts`, `packages/core/src/plugins/builtins.ts` | Store and localize Guardian strategy and target. |
| Guardian logic | `packages/plugins/openai-chatgpt/src/runtime/guardian/{request,questions,decision,response,wrapper}.ts` with local tests | Recognize the observed profile, preserve full input, ask/validate choices, create Guardian-shaped output, and control fallback. |
| Private host | `packages/server/src/plugin-runtime/{types,materialize}.ts`, `packages/server/src/server-state/{index,snapshot}.ts`, `packages/server/src/routes/pipeline/attempt/evaluation.ts` and a focused private evaluator module | Inject one callback into only the built-in ChatGPT runtime and dispatch the exact leased evaluation candidate with normal usage attribution. |
| Payload capture policy | `packages/plugins/openai-chatgpt/src/runtime/guardian/request.ts`, `packages/server/src/routes/pipeline/index.ts`, `packages/server/src/request-logging/{context,wire}/`, and request-local diagnostics/trace emitters | Let the plugin give a conservative early sensitivity hint; establish a generic request-scoped no-payload policy before inbound observation and retain it through all sends. |
| Raw accounting | `packages/server/src/routes/pipeline/attempt/{raw,raw-retry}.ts`, `packages/server/src/usage-capture/` as needed | Carry trusted per-invocation original-transport-started state through preflight/retry and suppress synthetic ChatGPT fee without affecting response/session observation. |
| Dashboard | `packages/dashboard/src/modules/plugins/{components,services,hooks}/`, `packages/dashboard/src/lib/provider-summaries-query.ts`, `packages/i18n/messages/*.json` | Show conditional target controls, use configured Provider data, keep invalid saved IDs visible, and validate before save. |
| Integration/release | focused server/plugin tests, one `.changeset/*.md` | Check actual routing, usage, cancellation, privacy, Codex-compatible output, and release note. |

The private callback is a structural extra property on the runtime context object supplied only for the built-in ChatGPT adapter. It is **not** added to public `RuntimeContext` or `PluginDescriptor` types. Both internal sides agree on:

```ts
type GuardianChoiceQuestion = {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
};
type GuardianSystemOneBody = {
  readonly model: string;
  readonly state: { readonly input: readonly unknown[]; readonly pending_action: Record<string, unknown> };
  readonly questions: Readonly<Record<string, GuardianChoiceQuestion>>;
};
type GuardianEvaluate = (input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly body: GuardianSystemOneBody;
  readonly signal: AbortSignal;
  readonly logicalRequest: LogicalRequestContext;
}) => Promise<unknown>;
```

The runtime context extra property is named `__aioGuardianEvaluate`; both packages use the structural signature above without adding it to public SDK types. Import the existing `LogicalRequestContext` from `@aio-proxy/plugin-sdk`. The host binds the source ChatGPT Provider ID when it injects this function; it is never read from inbound metadata. The evaluator response is `unknown` until the plugin validates all four answers. The built-in wrapper writes invocation-local `originalTransportStarted` and `syntheticGuardianResponse` flags; the host suppresses the ChatGPT fee only for a synthetic final response. Keep both flags out of HTTP headers and Provider-controlled data.

### Task 1: Extend the generic plugin form contract

**Files:**
- Modify: `packages/plugin-sdk/src/config.ts`
- Move: `packages/core/src/plugins/config-spec.ts` to `packages/core/src/plugins/config-spec/config-spec.ts`
- Create: `packages/core/src/plugins/config-spec/index.ts` (export-only entry, preserving existing imports)
- Modify: `packages/types/src/dashboard-oauth.ts`
- Modify: `packages/server/src/dashboard-routes/oauth-capabilities.ts`
- Test: `packages/core/src/plugins/config-spec/config-spec.test.ts`, `packages/types/src/dashboard/dashboard.test.ts`

**Interfaces:**
- Consumes: existing `FormField`, `FormCondition`, `DashboardOAuthFormFieldSchema`, and `dashboardOAuthForm`.
- Produces: `FormCondition = {key,equals} | {key,notEquals}` and generic field types `provider` and `provider-model` where `provider-model.providerKey` names an earlier `provider` field. The dashboard DTO projects the same shape, with no Provider data embedded in the form descriptor.

- [ ] **Step 1: Write failing behavior tests.** A valid form contains a strategy `select`, then a `provider` field with `when: {key:'strategy',notEquals:'default'}`, then a `provider-model` field with `providerKey:'providerId'` and the same condition. Assert `validateConfigSpec` and `DashboardOAuthFormFieldSchema` retain both fields; reject `provider-model` referencing a missing or later Provider field and a condition carrying both `equals` and `notEquals`.

```ts
const fields = [
  { type: 'select', key: 'strategy', label: 'Strategy', options: [{ value: 'default', label: 'Default' }] },
  { type: 'provider', key: 'providerId', label: 'Provider', when: { key: 'strategy', notEquals: 'default' } },
  { type: 'provider-model', key: 'modelId', label: 'Model', providerKey: 'providerId', when: { key: 'strategy', notEquals: 'default' } },
] as const;
expect(validateConfigSpec({ schema: zod.object({}), form: fields }).spec.form).toEqual(fields);
expect(DashboardOAuthFormFieldSchema.safeParse(fields[2]).success).toBe(true);
```

- [ ] **Step 2: Run the focused tests to see the missing field/condition failures.** Run `rtk bun test packages/core/src/plugins/config-spec/config-spec.test.ts packages/types/src/dashboard/dashboard.test.ts`. Expected: FAIL on the new cases, with unrelated tests unchanged.
- [ ] **Step 3: Add the two field variants and discriminated condition, then validate them at the descriptor boundary.** Reject blank `providerKey`, an unknown or later key, and a key whose earlier field is not `provider`; preserve current `equals` behavior. Move `config-spec.ts` into its same-name directory, change its `./schema` import to `../schema`, and export its existing public symbols from the new `index.ts` so current barrel imports keep working. Project the two variants unchanged through `dashboardOAuthForm` and the strict dashboard DTO.

```ts
export type FormCondition =
  | { readonly key: string; readonly equals: string | number | boolean | null }
  | { readonly key: string; readonly notEquals: string | number | boolean | null };
export type ProviderField = FormFieldBase<'provider'>;
export type ProviderModelField = FormFieldBase<'provider-model'> & { readonly providerKey: string };
```

- [ ] **Step 4: Run `rtk bun test packages/core/src/plugins/config-spec/config-spec.test.ts packages/types/src/dashboard/dashboard.test.ts` and `rtk bun run check`; require all focused cases and lint/format to pass.** Commit only these contract/DTO files with `feat(plugin-sdk): add provider target form fields` and the required `Co-authored-by: Codex <noreply@openai.com>` footer.

### Task 2: Render the new fields in the CLI

**Files:**
- Modify: `packages/cli/src/plugin-commands/form/render.ts`
- Test: the colocated `packages/cli/src/plugin-commands/form/render.test.ts`

**Interfaces:**
- Consumes: Task 1's `provider`, `provider-model`, and `notEquals` form variants.
- Produces: exact Provider ID and model slug input as strings in `renderConfigSpec`'s existing `publicValues`; no Provider listing or network lookup in CLI.

- [ ] **Step 1: Add a failing CLI form test.** Prompt the strategy as `systemOne`, enter `system-one-local` and `jev-latest`, and assert both exact strings are returned; when strategy is `default`, assert neither Provider/model prompt is called. Retaining previously saved IDs in default mode is optional; the runtime never uses them.

```ts
expect(result.publicValues).toMatchObject({
  strategy: 'systemOne', providerId: 'system-one-local', modelId: 'jev-latest',
});
expect(prompted).toEqual(['strategy', 'providerId', 'modelId']);
```

- [ ] **Step 2: Run `rtk bun test packages/cli/src/plugin-commands/form/render.test.ts`; expect the new case to fail on unsupported field type/visibility.**
- [ ] **Step 3: In `visible`, check the chosen discriminant (`'equals' in field.when`); in `promptFieldValue`, send both new types to the existing text `prompts.input` path and trim their result.** Keep the schema as the authority for nonempty IDs and invalid values; the renderer does not guess routability.

```ts
if (field.when !== undefined) {
  const actual = values[field.when.key];
  if ('equals' in field.when ? actual !== field.when.equals : actual === field.when.notEquals) return false;
}
case 'provider':
case 'provider-model':
  return (await prompts.input({ message, defaultValue: typeof promptDefault === 'string' ? promptDefault : undefined }, context)).trim();
```

- [ ] **Step 4: Run `rtk bun test packages/cli/src/plugin-commands/form/render.test.ts` and `rtk bun run check`.** Commit the CLI change with `feat(cli): accept guardian provider target fields` and the required coauthor footer.

### Task 3: Add ChatGPT Guardian settings and localized copy

**Files:**
- Modify: `packages/plugins/openai-chatgpt/src/plugin-options/plugin-options.ts`
- Modify: `packages/plugins/openai-chatgpt/src/plugin/plugin.ts`
- Modify: `packages/core/src/plugins/builtins.ts`
- Test: `packages/plugins/openai-chatgpt/src/plugin-options/plugin-options.test.ts`, `packages/plugins/openai-chatgpt/src/plugin/plugin.test.ts`

**Interfaces:**
- Consumes: Task 1's generic `provider` and `provider-model` fields and `notEquals` condition.
- Produces: `ChatGPTPluginOptions` with `guardianStrategy: 'default' | 'systemOne' | 'systemOneReviewDenied'`, optional `guardianProviderId`, optional `guardianModelId`; the existing user-agent settings remain unchanged. Runtime code in Task 9 consumes these exact names.

- [ ] **Step 1: Add failing option tests for empty/default, both active modes, and missing target.** Assert default parsing yields `guardianStrategy:'default'`; active strategies reject a blank Provider ID or model ID; default accepts retained IDs but never calls an evaluator. Assert form field order is strategy, Provider, model after the existing user-agent fields.

```ts
await expect(spec.schema.parseAsync({ guardianStrategy: 'systemOne', guardianProviderId: 'p', guardianModelId: 'm' }))
  .resolves.toMatchObject({ guardianStrategy: 'systemOne', guardianProviderId: 'p', guardianModelId: 'm' });
await expect(spec.schema.parseAsync({ guardianStrategy: 'systemOne', guardianProviderId: 'p' })).rejects.toThrow();
```

- [ ] **Step 2: Run `rtk bun test packages/plugins/openai-chatgpt/src/plugin-options/plugin-options.test.ts packages/plugins/openai-chatgpt/src/plugin/plugin.test.ts`; expect the new assertions to fail.**
- [ ] **Step 3: Extend the existing Zod options object with the three fields below, then chain the shown `superRefine` before its current output transform; keep the current user-agent fields in that object.** Add a strategy select with all three spec labels, then generic conditional Provider/model fields. Extend `ChatGPTPluginOptionsText`, its English defaults, and `createEmbeddedBuiltIns` with the Chinese/English labels, explanations, and disclosure that approval context goes to the selected Provider. Keep them plugin-level, outside account options.

```ts
const guardianOptions = zod.object({
  guardianStrategy: zod.enum(['default', 'systemOne', 'systemOneReviewDenied']).default('default'),
  guardianProviderId: zod.string().trim().min(1).optional(),
  guardianModelId: zod.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.guardianStrategy === 'default') return;
  for (const key of ['guardianProviderId', 'guardianModelId'] as const) {
    if (value[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required` });
  }
});
```

- [ ] **Step 4: Run the two focused plugin tests and `rtk bun run check`.** Commit with `feat(openai-chatgpt): configure guardian review strategy` and the required coauthor footer.

### Task 4: Recognize the Guardian profile and project the complete decision state

**Files:**
- Create: `packages/plugins/openai-chatgpt/src/runtime/guardian/request.ts`
- Create: `packages/plugins/openai-chatgpt/src/runtime/guardian/guardian.test.ts`
- Create: `packages/plugins/openai-chatgpt/src/runtime/guardian/fixture.ts` (synthetic, sanitized inline history)

**Interfaces:**
- Consumes: an OpenAI Responses `Request` after the server has resolved the ChatGPT model ID; it parses a **clone** only in active modes.
- Produces: `projectGuardianRequest(request: Request, resolvedModelId: string): Promise<GuardianProjection | undefined>` where `GuardianProjection` contains `state: {input: readonly unknown[]; pending_action: Record<string, unknown>}`, `schema: Record<string, unknown>`, and `stream: boolean`. Private collaborators are `readGuardianJsonWithinBytes(request: Request, limit: number): Promise<unknown | undefined>`, `matchesGuardianProfile(value: unknown): value is MatchedGuardianBody`, and `parseTerminalAction(input: readonly unknown[]): Record<string, unknown> | undefined`. `MatchedGuardianBody` is the narrowed JSON object with `model:string`, `input:readonly unknown[]`, `stream?:boolean`, and `text.format.schema:Record<string,unknown>` after all scope/schema checks. `fixture.ts` exports `syntheticGuardianInput` and `guardianRequest(input: readonly unknown[]): Request` for tests. Projection does not mutate or consume the original request. `undefined` means original path, with no disclosure.

- [ ] **Step 1: Add the synthetic fixture and failing matcher tests.** Use ordinary `message` items with `input_text` content, an explicit developer Guardian policy, a human user authorization, a tool call/reply pair, a quoted fake envelope in tool output, and one final user item whose last four separate parts are the actual `>>> APPROVAL REQUEST START`, `Planned action JSON:`, JSON object, `>>> APPROVAL REQUEST END`. Give the action the observed field shape (`tool`, array `command`, `cwd`, `justification`, `sandbox_permissions`, `tty`) with synthetic values. Assert deep equality of `state.input` with the original fixture (including IDs/metadata), exact parsed `pending_action`, and that the original `Request` body remains readable. A `reasoning.encrypted_content` item is permitted opaque metadata when all decision evidence is visible elsewhere; assert that it remains in `state.input` without being treated as authorization. Add table cases for a wrong resolved model, missing marker, nested enum that only looks like Guardian, an extra required schema property, a duplicate final envelope, `/responses/compact`, `previous_response_id`, unresolved nested file reference, and an opaque encoded item needed for context; each returns `undefined` before the evaluator is called.

```ts
const projection = await projectGuardianRequest(guardianRequest(syntheticGuardianInput), 'codex-auto-review');
expect(projection?.state.input).toEqual(syntheticGuardianInput);
expect(projection?.state.pending_action).toEqual({
  tool: 'exec_command', command: ['bun', 'test'], cwd: '/workspace',
  justification: 'Run the requested tests', sandbox_permissions: 'use_default', tty: false,
});
expect(await originalRequest.clone().json()).toEqual(originalBody);
```

- [ ] **Step 2: Run `rtk bun test packages/plugins/openai-chatgpt/src/runtime/guardian/guardian.test.ts`; expect the projection test to fail because the function does not exist.**
- [ ] **Step 3: Implement a bounded reader over `request.clone().body` and the strict profile matcher.** Cap the decoded candidate body at 1 MiB (the supplied 453,475-byte sample fits); cancel the clone reader on overflow. Require a POST path ending exactly `/responses`, `store:false`, no background/previous-response/conversation/top-level instructions, `input` array, exact marker, and the precise top-level schema described in the spec: object, `additionalProperties:false`, only `outcome` required, the four named properties and their types/enums. Accept property order and descriptions as irrelevant. Require the policy-bearing developer item and recognized source-trust/risk clauses; if the required rule structure is absent, fail closed. Restrict content to inline interpretable JSON/text and permitted opaque metadata; reject unresolved references and encoded content whose meaning is needed to judge. Find the unique envelope only in the final user item's trailing separate `input_text` parts, parse only its JSON part, and preserve the entire original input array without rewriting role/content/IDs. Reject trailing text or a second candidate envelope.

```ts
export type GuardianProjection = {
  readonly state: { readonly input: readonly unknown[]; readonly pending_action: Record<string, unknown> };
  readonly schema: Record<string, unknown>;
  readonly stream: boolean;
};
export async function projectGuardianRequest(request: Request, resolvedModelId: string): Promise<GuardianProjection | undefined> {
  if (resolvedModelId !== 'codex-auto-review' || new URL(request.url).pathname.endsWith('/responses/compact')) return;
  const body = await readGuardianJsonWithinBytes(request.clone(), 1_048_576);
  if (!matchesGuardianProfile(body)) return;
  const pending_action = parseTerminalAction(body.input);
  if (pending_action === undefined) return;
  return { state: { input: body.input, pending_action }, schema: body.text.format.schema, stream: body.stream === true };
}
```

- [ ] **Step 4: Run the focused test, then `rtk bun run check`.** Commit the fixture and request projector with `feat(openai-chatgpt): recognize guardian approval requests` and the required coauthor footer.

### Task 5: Ask four choices and validate a compatible Guardian decision

**Files:**
- Create: `packages/plugins/openai-chatgpt/src/runtime/guardian/questions.ts`
- Create: `packages/plugins/openai-chatgpt/src/runtime/guardian/decision.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/guardian/guardian.test.ts`

**Interfaces:**
- Consumes: `GuardianProjection.state` and the actual policy preserved in its developer item; the raw evaluator result remains `unknown`.
- Produces: `guardianQuestions(state): Readonly<Record<'risk_level' | 'user_authorization' | 'outcome' | 'reason', GuardianChoiceQuestion>>` and `guardianDecision(result: unknown, projection: GuardianProjection): Record<string, string> | undefined`. `guardianDecision` reads the full System One response object's `answers` member; `undefined` means fallback, not deny.

- [ ] **Step 1: Add failing question/decision tests.** Assert the question IDs and **ordered** literal label sets exactly match the spec and the instructions refer to `state.input`'s developer policy and source trust. Feed complete four-answer distributions for low allow, medium allow, high narrow allow, and every mapped deny row; assert the exact deterministic JSON shape. Feed every incompatible pair (`low + allow + policy_prohibition`, `critical + allow`, `high + allow + low authorization`, `uncertain`), plus missing/extra answer, wrong type, unknown selected label, missing/extra probability key, `-0.1`, `1.1`, `NaN`; all return `undefined`.

```ts
expect(Object.keys(guardianQuestions(projection.state))).toEqual([
  'risk_level', 'user_authorization', 'outcome', 'reason',
]);
expect(guardianDecision(validLowAllow, projection)).toEqual({ outcome: 'allow' });
expect(guardianDecision(lowAllowWithProhibitionReason, projection)).toBeUndefined();
```

- [ ] **Step 2: Run `rtk bun test packages/plugins/openai-chatgpt/src/runtime/guardian/guardian.test.ts`; expect the new choice/decision tests to fail.**
- [ ] **Step 3: Implement literal criteria and one table-driven compatibility map.** The criteria maps are `risk_level: low/medium/high/critical`, `user_authorization: unknown/low/medium/high`, `outcome: allow/deny`, and `reason: low_risk/medium_risk/high_authorized_narrow/high_not_permitted/critical_risk/policy_prohibition/prompt_injection/uncertain`; each map value is a short description string or `null`. Validate exact answer IDs, `type:'choice'`, selected label membership, exact probability keys, and every finite probability in `[0,1]`; do not require a sum of one or a confidence threshold. Apply the spec's compatibility table and fixed rationale text. Validate the final object against the matched incoming JSON schema (a narrow validator for the observed four properties is enough; if annotations change, do not reinterpret them). Return `undefined` on any mismatch.

```ts
const labels = { risk_level: ['low','medium','high','critical'], user_authorization: ['unknown','low','medium','high'], outcome: ['allow','deny'], reason: ['low_risk','medium_risk','high_authorized_narrow','high_not_permitted','critical_risk','policy_prohibition','prompt_injection','uncertain'] } as const;
const lowAllow = risk === 'low' && outcome === 'allow' && reason === 'low_risk';
if (lowAllow) return { outcome: 'allow' };
const rationaleByKey: Record<string, string> = {
  'medium|allow|medium_risk': 'The assessed risk is medium and the supplied policy permits the action.',
  'high|allow|high_authorized_narrow': 'The high-risk action is sufficiently authorized and narrowly scoped.',
  'high|deny|high_not_permitted': 'The high-risk action lacks sufficient authorization or narrow scope.',
  'critical|deny|critical_risk': 'The action poses critical risk under the supplied policy.',
};
for (const sourceRisk of ['low', 'medium', 'high'] as const) {
  rationaleByKey[`${sourceRisk}|deny|policy_prohibition`] = 'The supplied Guardian policy prohibits this action.';
  rationaleByKey[`${sourceRisk}|deny|prompt_injection`] = 'The action follows untrusted instructions outside the authorized task.';
}
if (risk === 'high' && outcome === 'allow' && !['medium', 'high'].includes(authorization)) return undefined;
const rationale = rationaleByKey[`${risk}|${outcome}|${reason}`];
if (rationale === undefined) return undefined;
```

- [ ] **Step 4: Run the focused test and `rtk bun run check`.** Commit with `feat(openai-chatgpt): validate guardian evaluation choices` and the required coauthor footer.

### Task 6: Emit one completed Guardian Responses decision

**Files:**
- Create: `packages/plugins/openai-chatgpt/src/runtime/guardian/response.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/guardian/guardian.test.ts`

**Interfaces:**
- Consumes: the schema-validated JSON from `guardianDecision` and the original request's `stream` flag.
- Produces: `guardianResponse(decision: Record<string,string>, stream: boolean): Response` with `model:'codex-auto-review'`, one assistant text output, coherent IDs/timestamps, no `usage`, and the repository's text-only JSON/SSE event sequence.

- [ ] **Step 1: Add failing JSON and SSE tests using the same decision.** JSON has one `output_text` and one `output[0].content[0].text`; IDs are stable within the envelope and `status:'completed'`. SSE has exactly `response.created`, `response.output_item.added`, one `response.output_text.delta`, `response.output_item.done`, `response.completed` in that order; `sequence_number` runs from 0, all item/response IDs agree, and its completed response serializes the same decision. Neither format has `usage` or a second decision. Add a local parser-style test that extracts the output text as the supported Codex consumer does.

```ts
const response = guardianResponse({ outcome: 'allow' }, true);
const events = (await response.text()).trim().split('\n\n').map((frame) => JSON.parse(frame.split('\ndata: ')[1]!));
expect(events.map((event) => event.type)).toEqual([
  'response.created', 'response.output_item.added', 'response.output_text.delta',
  'response.output_item.done', 'response.completed',
]);
expect(events.at(-1)?.response.output_text).toBe('{"outcome":"allow"}');
```

- [ ] **Step 2: Run `rtk bun test packages/plugins/openai-chatgpt/src/runtime/guardian/guardian.test.ts`; expect the new writer tests to fail.**
- [ ] **Step 3: Build the full response object once before emitting bytes; derive both JSON and SSE from that object.** Use `crypto.randomUUID()` for `resp_` and `msg_` IDs and `Math.floor(Date.now()/1000)` for timestamps. Follow `packages/core/src/egress/openai-responses/{state,sse}.ts` for the text-only item fields and event shapes; do not import core into the plugin (core imports this built-in plugin). Set `Content-Type` to JSON or `text/event-stream` and emit no usage field. The SSE frame builder serializes each complete event as `event: <type>\ndata: <json>\n\n`.

```ts
const decisionText = JSON.stringify(decision);
const createdAt = Math.floor(Date.now() / 1000);
const responseId = `resp_${crypto.randomUUID()}`;
const messageId = `msg_${crypto.randomUUID()}`;
const completed = {
  id: responseId, created_at: createdAt, completed_at: createdAt,
  object: 'response', model: 'codex-auto-review', status: 'completed',
  output_text: decisionText,
  output: [{ id: messageId, type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: decisionText, annotations: [], logprobs: [] }] }],
  error: null, incomplete_details: null, instructions: null, metadata: null,
  parallel_tool_calls: false, temperature: null, tool_choice: 'auto', tools: [], top_p: null,
};
```

- [ ] **Step 4: Run the focused test and `rtk bun run check`.** Commit with `feat(openai-chatgpt): emit guardian responses decisions` and the required coauthor footer.

### Task 7: Compose a private exact-candidate System One evaluator

**Files:**
- Create: `packages/server/src/plugin-runtime/guardian-evaluation/index.ts` (exports only)
- Create: `packages/server/src/plugin-runtime/guardian-evaluation/guardian-evaluation.ts`
- Create: `packages/server/src/plugin-runtime/guardian-evaluation/guardian-evaluation.test.ts`
- Modify: `packages/server/src/plugin-runtime/types.ts`
- Modify: `packages/server/src/plugin-runtime/materialize.ts`
- Modify: `packages/server/src/server-state/index.ts`
- Modify: `packages/server/src/server-state/snapshot.ts`
- Modify: `packages/server/src/server-state/types.ts` (internal option only)
- Modify: `packages/server/src/routes/pipeline/attempt/evaluation.ts` (extract candidate transport operation without copying the loop)

**Interfaces:**
- Consumes: Task 5's System One body shape, `typeSafeSystemOneAdapter`, `ProviderRouteSource.acquireProviderSnapshot`, and the existing candidate's `raw.resolve` or `evaluation.discover` transport.
- Produces: the private `GuardianEvaluate` callback defined above, bound to the source ChatGPT Provider ID when materializing that built-in. It is passed as `__aioGuardianEvaluate` on the `adapter.createRuntime` context only for `@aio-proxy/plugin-openai-chatgpt`; public SDK types are unchanged. `GuardianEvaluationUnavailable` carries only a bounded reason code and safe IDs. The callback receives the existing `LogicalRequestContext`, so the raw transport can retain correlation without inventing a session key.
- Produces: `dispatchPrivateEvaluation(input: {candidate: RouterCandidate<RuntimeProviderInstance>; body: GuardianSystemOneBody; signal: AbortSignal; logicalRequest: LogicalRequestContext; source: ProviderRouteSource; routerModels: Readonly<Record<string, RouterModelPolicy>> | undefined}): Promise<unknown>` in the private evaluator module. This helper receives the already verified candidate; the callback alone acquires/releases the snapshot lease and checks the qualified route.

- [ ] **Step 1: Add failing host tests with two Providers advertising the same model, a disabled target, a slash alias, a selected Provider that throws, and snapshot replacement during an in-flight evaluation.** Assert only the configured `providerId/modelId` qualified route is dispatched, with `selectionSource:'provider_qualified'` and the exact candidate object from the leased snapshot. A removed qualified route must not resolve an ordinary alias with the same slash string. Test that a target equal to the source ChatGPT Provider is rejected before dispatch, that neither caller API key nor ChatGPT OAuth token reaches System One, and that an `ai-sdk` Provider with no evaluation model becomes unavailable without trying another Provider. Hold a response body open across a snapshot swap and assert the lease releases only after consumption/cancel.

```ts
const result = await host({ providerId: 'system-one-local', modelId: 'jev-latest', body, signal, logicalRequest });
expect(systemOneCalls).toEqual([{ providerId: 'system-one-local', modelId: 'jev-latest' }]);
expect(otherProviderCalls).toHaveLength(0);
expect(leaseReleased).toBe(true);
```

- [ ] **Step 2: Run `rtk bun test packages/server/src/plugin-runtime/guardian-evaluation/guardian-evaluation.test.ts`; expect the new host tests to fail because the capability is absent.**
- [ ] **Step 3: Extract only the transport selection from `attemptEvaluationCandidate` and use it in both callers.** `selectEvaluationTransport({candidate, protocol, requestPath, urlTemplate})` returns `{kind:'raw', transport}`, `{kind:'convert', transport}`, or `{kind:'unsupported'}`. The route passes the same `requestPathProperty(rawRequest, ctx.httpRoute)` fields it uses today and keeps its raw `completeRawAttempt`, converted `evaluationJson`, emitter, fallback loop, and error mapping; no public `/v1/systemone` behavior changes. The private host builds a trusted in-memory `POST http://aio-proxy.invalid/v1/systemone` Request with the configured body and evaluation signal, parses it with `typeSafeSystemOneAdapter.parse`, and passes `/v1/systemone` to the selector. On raw selection it uses the adapter's model-only rewrite, `withoutCallerCredentialsOnRequest`, the selected raw transport, `usageCapture.passthrough`, and a bounded reader of the captured response body; on converted selection it calls `discover()`, then `evaluate(typeSafeSystemOneAdapter.evaluationInvocation(request, {}), {modelId:candidate.modelId, signal})`, then `usageCapture.evaluation` **before** `evaluationJson` so a returned but malformed answer retains available usage. Non-2xx, unsupported discovery, oversized or invalid JSON, and invalid distribution return a bounded unavailable reason. Neither path re-resolves or starts a candidate loop. Race the selected transport against `signal`; abort cancels the reader, rejects the helper promptly even if the transport ignores the signal, and cancels any late response body.

  The existing recorder persists usage only through `session.finish`/`finishFrom`; calling `usageCapture` alone would lose the charge. Give each private evaluation its own internal `RequestTraceSession` with a fresh request ID (`withRequestId`) and a trace link to the parent request, then settle one evaluation attempt through `createAttemptEmitter`. Use one recorder-only Request carrying the trace link and a separate credential-free Request for dispatch; the link header must not reach the Provider. Set a safe `aio_proxy.guardian.parent_request_id` attribute on the internal root span from `logicalRequest.requestId`. Run the dispatch under `withRequestLogContext({requestId: internalId, debug:false, logger:source.logger, rootContext:session.rootContext})` so the existing observed fetch does not capture evaluation payloads and usage-resolution spans attach to the internal trace. Its Provider usage and cost belong to that internal trace, while the outer Guardian trace records only any real ChatGPT response. Aggregate cost counts the internal evaluation once. A direct synthetic response has no ChatGPT cost. Tests assert two distinct trace IDs and request IDs, selected-Provider attribution after invalid Guardian output, and no duplicate cost in the aggregate.

```ts
export function selectEvaluationTransport(input: {
  readonly candidate: RouterCandidate<RuntimeProviderInstance>;
  readonly protocol: ProviderProtocol;
  readonly requestPath: string;
  readonly urlTemplate?: string;
}):
  | { readonly kind: 'raw'; readonly transport: RawTransport }
  | { readonly kind: 'convert'; readonly transport: LazyEvaluationTransport }
  | { readonly kind: 'unsupported' };
```

- [ ] **Step 4: In `initializeServerState`, create a closure that resolves the active state only after initialization, pass it through internal snapshot/materialization options on initial build and every reload, and bind `sourceProviderId = config.id` when injecting into the ChatGPT `createRuntime` context.** The callback acquires one snapshot, resolves `${providerId}/${modelId}`, requires one `provider_qualified` candidate from the configured Provider, rejects self-recursion, and passes that exact candidate to the helper. Release the snapshot lease in `finally` after the abort-aware helper settles. The callback does not use the inbound URL, external routing weights, caller credentials, or a loopback request.

```ts
try {
  const matches = lease.snapshot.router.resolve(`${providerId}/${modelId}`);
  if (matches.length !== 1 || matches[0]?.provider.id !== providerId || matches[0].selectionSource !== 'provider_qualified') {
    throw new GuardianEvaluationUnavailable('target_unavailable');
  }
  if (matches[0].provider.id === sourceProviderId) throw new GuardianEvaluationUnavailable('recursive_target');
  return await dispatchPrivateEvaluation({ candidate: matches[0], body, signal, logicalRequest, source, routerModels: lease.snapshot.config?.router.models });
} finally {
  lease.release();
}
```

- [ ] **Step 5: Run `rtk bun test packages/server/src/plugin-runtime/guardian-evaluation/guardian-evaluation.test.ts packages/server/src/routes/pipeline/attempt/evaluation.test.ts packages/server/src/plugin-runtime/materialize.test.ts` and `rtk bun run check`.** Commit the host seam and candidate operation with `feat(server): dispatch private guardian evaluation target` and the required coauthor footer.

### Task 8: Establish the early no-payload capture policy

**Files:**
- Modify: `packages/plugins/openai-chatgpt/src/runtime/guardian/request.ts` and its colocated tests
- Modify: `packages/server/src/server-state/{index,snapshot}.ts` and `packages/server/src/plugin-runtime/materialize.ts` for the private built-in hint registration on initial build and reload
- Modify: `packages/server/src/runtime.ts`, `packages/server/src/routes/pipeline/index.ts`, and `packages/server/src/request-logging/{context,wire}/` for a generic request-scoped capture policy
- Modify: `packages/server/src/routes/pipeline/logging.ts`, `packages/server/src/routes/pipeline/tracing.ts`, and `packages/server/src/routes/pipeline/attempt/emit/emit.ts` only where their existing error/response attributes can carry Provider-controlled text
- Test: `packages/server/src/routes/pipeline/debug-logging.test.ts` and focused request-logging tests

**Interfaces:**
- Produces: a private, plugin-owned `guardianPayloadHint(request, options)` that returns `sensitive` or `normal` before ingress observation. It is a **capture hint**, not the full Task 4 eligibility decision: a Guardian-looking but ineligible request still uses the original model and keeps its transcript out of diagnostic sinks. The host registers this hint only for an active System One strategy in the built-in ChatGPT plugin; it does not add a public SDK hook or server-owned Guardian matcher.
- Produces: an optional generic `preObservationCapturePolicy` on the internal route source. Before `requestRecorder.begin` and `observeInboundRequest`, the route asks a **leased** Provider snapshot's registered hint for a request-local `capturePayload` decision. That same snapshot must drive the later candidate selection; otherwise a reload could enable Guardian evaluation after an old snapshot allowed body capture. The policy is propagated through the parent attempt, nested evaluation, captured original transport, raw replay, Provider failover, and response observation. It does not decide routing or approval.

- [ ] **Step 1: Add failing tests for the observation order and conservative hint.** With debug logging and trace export enabled, have a synthetic Guardian request assert inside a fake `raw.invoke` that no transcript sentinel has reached any sink **before** the plugin runs. Repeat for a fallback and a retry; after completion, assert no inbound, upstream-request, or upstream-response body chunk contains it. A non-Guardian Responses request still produces its existing debug body capture under an active strategy, and `default` still takes the existing path without preflight parsing or logging changes. A malformed, unreadable, or over-limit preflight clone uses `sensitive` conservatively and leaves normal protocol error handling in place. Reload the Provider snapshot between the hint and candidate selection: this request must keep the original snapshot and its privacy decision, and all early rejection/streaming paths must release the lease exactly once.
- [ ] **Step 2: Implement the plugin-owned early hint and register it from host-controlled composition.** Inspect a bounded clone of OpenAI Responses JSON only when a System One strategy is active. A plain `client_metadata["x-openai-subagent"] === "guardian"` is enough to suppress capture; do **not** require complete schema, resolved model, or a valid final envelope at this stage. Missing marker on valid JSON returns `normal`; ambiguous read/parse/size outcomes return `sensitive`. Use the protocol's existing body limit for the clone, cancel its reader on the limit, and never alter or consume the original request. Aggregate active built-in ChatGPT hints in each immutable Provider snapshot so the host can call them before model routing; refresh that registration with each snapshot. Other plugins and Providers acquire no new public model-call or Guardian API.
- [ ] **Step 3: Apply the generic policy before any payload write.** For OpenAI Responses, move the pipeline's existing `acquireProviderSnapshot()` from `attemptResolvedRequest` to the entry before the hint lookup; pass that same lease to candidate selection and transfer its current deferred-release ownership for streaming. Release it once on parsing/rejection/abort before routing, and on the existing completion path after routing. A strategy reload after this point affects the next request, not the current request's capture policy or runtime. Keep the existing acquisition point for other protocols. `requestRecorder.begin` currently extracts request metadata and trace links, not the body; still compute the capture decision before calling it. Carry `capturePayload:false` in the existing request-log scope rather than turning off all diagnostics. In `observeInboundRequest`, reuse the existing omitted-body terminal path; in `createObservedFetch`, omit chunks for both outbound request and response while retaining bounded snapshots, status, timing, usage, and terminal observations. Ensure the same scope reaches the original ChatGPT fallback, raw retry, and Provider failover. The private evaluation continues to use `debug:false` plus this parent policy. Do not buffer transcript chunks with a plan to delete them later.
- [ ] **Step 4: Bound non-body diagnostic and trace values for a sensitive scope.** Route request-local logs through an allowlist that keeps locally authored reason codes, validated Provider/model IDs, status, duration, strategy, and correlation ID; discard Provider-controlled exception `code`/`causeCode`/`syscall`, response IDs, header values, and raw error text unless independently validated as safe. Apply the same rule to attempt/root span attributes and exported events before persistence/export; `serverErrorDetails`, `logProviderAttemptFailed`, `OpenSpan.end`, and `createAttemptEmitter.endAttempt` are the existing review points. Do not strip usage numbers or Provider attribution. Inject a sentinel into an evaluator exception code and an upstream response ID in tests, not just the response body.
- [ ] **Step 5: Run the focused plugin, logging, and route tests plus `rtk bun run check`.** Commit the privacy seam with `feat(server): protect guardian request diagnostics` and the required coauthor footer.

### Task 9: Wrap ChatGPT raw transport and coordinate fallback, timeout, and billing

**Files:**
- Create: `packages/plugins/openai-chatgpt/src/runtime/guardian/index.ts` (exports only)
- Create: `packages/plugins/openai-chatgpt/src/runtime/guardian/guardian.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/guardian/guardian.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/raw.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.ts` (preserve invocation metadata across response rewrap)
- Test: `packages/server/src/routes/pipeline/raw-session.test.ts`, `packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.test.ts`

**Interfaces:**
- Consumes: Tasks 3–8's options and early capture policy, `projectGuardianRequest`, `guardianQuestions`, `guardianDecision`, `guardianResponse`, and private evaluator callback. The raw resolver closes over the **resolved** `modelId` and the host-bound source Provider ID.
- Produces: `createGuardianRawInvoke(input: { resolvedModelId: string; pluginOptions: ChatGPTPluginOptions; original: RawTransport['invoke']; evaluate?: GuardianEvaluate }): RawTransport['invoke']`, used only by ChatGPT's OpenAI Responses raw transport. Its captured `original(request, context, options)` is invoked at most once per wrapper call. It sets `originalTransportStarted` immediately before calling the original or `syntheticGuardianResponse` immediately before returning a fully built synthetic response. `completeRawAttempt` suppresses cost only when the final invocation has `syntheticGuardianResponse === true` and `originalTransportStarted === false`; an untouched marker on another ChatGPT model leaves normal billing intact. If `context?.requestId` is absent, call the original without evaluation; it cannot get a traceable private host call.
- Produces: private `raceWithAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T>` in `guardian.ts`; it rejects an already-aborted signal before starting the operation, installs its abort listener before calling `start`, and attaches both settlement handlers to every started promise. A monotonic `deadlineAt` remains authoritative after that promise settles, including synchronous decision validation and response construction. The host cancels an evaluation response body that arrives after the signal aborted.

- [ ] **Step 1: Add failing wrapper and raw-accounting tests.** Verify default and non-Guardian requests call the captured transport with an untouched body and no evaluator call; a valid allow returns synthetic output without credential refresh or ChatGPT fetch; direct deny is final in `systemOne`; valid deny invokes the original once in `systemOneReviewDenied`, whose allow/deny/error is final; an evaluator throw, invalid answers, or deadline uses the original once while live. Abort while `projectGuardianRequest` is pending, then let projection finish: no evaluator call, original-model call, synthetic response, or unhandled rejection may follow. Also test an evaluator that synchronously aborts and returns an abort-rejecting promise; its rejection must be handled. Force a valid evaluation to settle, then abort the caller in a queued microtask before the wrapper continuation; it must not return synthetic output or start fallback. Advance a fake monotonic clock past the deadline during synchronous answer validation; it must use the original only while the caller remains live. Simulate an outer raw retry and Provider failover: they may create another wrapper invocation, but no invocation recurses. Assert a synthetic 2xx never writes a ChatGPT usage row or flat request fee, while a real original-model success keeps its existing usage/fee, and evaluation usage remains on its own Provider. Test `denial → original retryable failure → outer retry → evaluation allow`: the failed send remains observable, the final synthetic response gets no ChatGPT fee, and neither evaluation cost is lost or doubled.

```ts
expect(originalCalls).toBe(0);
expect(evaluationCalls).toBe(1);
expect(chatgptFeeRows).toHaveLength(0);
expect(systemOneFeeRows).toHaveLength(1);
```

- [ ] **Step 2: Run `rtk bun test packages/plugins/openai-chatgpt/src/runtime/guardian/guardian.test.ts packages/server/src/routes/pipeline/raw-session.test.ts packages/server/src/routes/pipeline/attempt/raw-retry/raw-retry.test.ts`; expect new cases to fail.**
- [ ] **Step 3: Wrap only `protocol === 'openai-response' && modelId === 'codex-auto-review'` in ChatGPT's raw resolver; leave AI SDK fetch, image endpoints, and the captured dynamic fetch unchanged.** For active modes, project a clone; if ineligible or target/context is missing, call original. Check caller cancellation immediately after projection, before building questions or starting evaluation. Build `GuardianSystemOneBody` from the configured model ID, `projection.state`, and `guardianQuestions(projection.state)`, then pass the configured Provider/model IDs, `context`, and an evaluation signal to the private callback. Record an absolute monotonic 8-second deadline before dispatch, combine the caller signal with `AbortSignal.timeout` using `AbortSignal.any`, and pass a **lazy** callback to `raceWithAbort` so an already-cancelled evaluation never starts or creates an orphaned promise. The timeout covers snapshot acquisition, body consumption, and **synchronous** answer validation: before dispatch, after callback settlement, after `guardianDecision`, and immediately before returning a fully built synthetic response, check caller cancellation first and then the absolute deadline. Caller cancellation throws without fallback; expiry calls the original only while live. A valid denial in `systemOneReviewDenied` calls the captured original; other valid decisions fully build `guardianResponse` before setting `syntheticGuardianResponse = true`. Set `originalTransportStarted = true` immediately before the captured original call. If evaluation finishes late after timeout, ignore it and cancel its body; do not switch after response construction has started.

```ts
const original = () => {
  if (request.signal.aborted) throw request.signal.reason ?? new DOMException('Aborted', 'AbortError');
  invocation.originalTransportStarted = true;
  return dynamicFetch(request, undefined, options);
};
if (evaluate === undefined || context === undefined ||
    pluginOptions.guardianProviderId === undefined || pluginOptions.guardianModelId === undefined) return original();
const projected = await projectGuardianRequest(request, resolvedModelId);
if (request.signal.aborted) throw request.signal.reason ?? new DOMException('Aborted', 'AbortError');
if (projected === undefined) return original();
const deadlineAt = performance.now() + 8_000;
const evaluationSignal = AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]);
const afterEvaluationWork = () => {
  if (request.signal.aborted) throw request.signal.reason ?? new DOMException('Aborted', 'AbortError');
  return evaluationSignal.aborted || performance.now() >= deadlineAt ? original() : undefined;
};
const body = { model: pluginOptions.guardianModelId, state: projected.state,
  questions: guardianQuestions(projected.state) } satisfies GuardianSystemOneBody;
const preDispatchFallback = afterEvaluationWork();
if (preDispatchFallback !== undefined) return preDispatchFallback;
let evaluated: unknown;
try {
  evaluated = await raceWithAbort(() => evaluate({ providerId: pluginOptions.guardianProviderId,
    modelId: pluginOptions.guardianModelId, body, signal: evaluationSignal, logicalRequest: context }), evaluationSignal);
} catch (error) {
  if (request.signal.aborted) throw request.signal.reason ?? error;
  return original();
}
const earlyFallback = afterEvaluationWork();
if (earlyFallback !== undefined) return earlyFallback;
const decision = guardianDecision(evaluated, projected);
const validationFallback = afterEvaluationWork();
if (validationFallback !== undefined) return validationFallback;
if (decision?.outcome === 'deny' && pluginOptions.guardianStrategy === 'systemOneReviewDenied') return original();
if (decision !== undefined) {
  const response = guardianResponse(decision, projected.stream);
  const finalFallback = afterEvaluationWork();
  if (finalFallback !== undefined) return finalFallback;
  invocation.syntheticGuardianResponse = true;
  return response;
}
return original();
```

```ts
function raceWithAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = () => signal.reason ?? new DOMException('Aborted', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(reason()); return; }
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(reason()); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    try {
      Promise.resolve(start()).then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    }
  });
}
```

- [ ] **Step 4: In `completeRawAttempt`, create one host-owned invocation marker for each `raw.invoke` and pass it as a private extra property on that invocation's options object.** Change `resolveRawRetry` to carry `{response, invocation}` as a pair: its SSE preflight may replace only `response`, and a replay produces a new pair. This keeps the final returned response tied to the invocation that produced it, including a first real ChatGPT call followed by a synthetic replay. The built-in wrapper writes only its marker; no response header, Provider payload, or later retry can overwrite an earlier marker. For a final synthetic ChatGPT response, pass no `configPrice` into `usageCapture.passthrough` and assert that its absent usage produces no ChatGPT row, while normal response/session-ID observation still runs. For a normal or real-original response, leave usage capture and fee exactly as today. A discarded failed raw-retry response remains governed by today's failed-response accounting; record its send in the attempt span, but do not invent token usage or a flat success fee. Test the exact `denial → original retryable failure → synthetic replay` sequence and assert the final synthetic call has no ChatGPT fee.

```ts
const invocation = { originalTransportStarted: false, syntheticGuardianResponse: false };
const response = await raw.invoke(request, logicalRequest, {
  upstreamStream: ctx.streamRequested,
  __aioGuardianInvocation: invocation,
} as RawTransportOptions);
return { response, invocation }; // resolveRawRetry preserves this pair across preflight and replay
// After retry: suppress ChatGPT price only when final.invocation.syntheticGuardianResponse
```

- [ ] **Step 5: Run the focused plugin and server tests plus `rtk bun run check`.** Commit with `feat(openai-chatgpt): orchestrate guardian review fallback` and the required coauthor footer.

### Task 10: Prove cancellation, observation, and no-payload diagnostics end to end

**Files:**
- Create: `packages/server/src/routes/pipeline/guardian-integration.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/guardian/guardian.test.ts`
- Modify when a failing integration test requires it: `packages/server/src/plugin-runtime/guardian-evaluation/guardian-evaluation.ts`, `packages/server/src/routes/pipeline/attempt/raw.ts`, and Task 8's ingress observation, request-log scope, diagnostic, and trace emitters

**Interfaces:**
- Consumes: Tasks 4–9's complete plugin wrapper, early capture policy, and private host callback through the normal `/v1/responses` route.
- Produces: a real-route regression harness that checks decisions, usage/trace attribution, response body release, and privacy with synthetic data. No production API or second route is added.

- [ ] **Step 1: Build a test server with one ChatGPT OAuth Provider and one local System One Provider, using an in-memory credential and a fake upstream.** Send the synthetic Guardian request through `/v1/responses` with the ChatGPT Provider's resolved model ID `codex-auto-review`. Assert `allow` and direct `deny` parse as one decision in JSON and SSE, the System One upstream sees the complete input and parsed pending action, and the ChatGPT upstream sees no request on direct decisions. In review-denied mode, assert a denial reaches ChatGPT once and its response is returned verbatim. Assert the selected Provider's usage row and the parent request trace have a single cost path, while ChatGPT has no synthetic fee.

```ts
const response = await app.request('/v1/responses', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(syntheticGuardianBody),
});
expect(response.status).toBe(200);
expect(systemOneRequests).toHaveLength(1);
expect(chatgptRequests).toHaveLength(0);
```

- [ ] **Step 2: Add controlled gates for abort before dispatch, while reading evaluation body, immediately before fallback, and after fallback starts.** Abort the caller at each gate and assert no new original request begins after pre-fallback cancellation; after fallback starts, the original receives the caller abort. Trigger a timeout and resolve the evaluator after fallback begins; assert the late result is ignored, its reader is cancelled, and the snapshot lease drains. Keep the deadline test below one second by injecting a timer/timeout factory into the private wrapper test seam; production remains 8 seconds.

```ts
caller.abort('disconnected');
await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
expect(chatgptRequests).toHaveLength(0);
expect(activeLeases()).toBe(0);
```

- [ ] **Step 3: Enable debug request logging, raw capture, and trace export in the test harness; place a unique sentinel in transcript, evaluator error code, and Provider-controlled response ID.** At the fake raw transport entry, assert no sentinel has **already** reached a sink. Run success, malformed answer, upstream non-2xx, timeout, cancel, valid denial followed by original-model fallback, and an outer retry. Inspect all diagnostic sinks and exported spans/attributes for the sentinel, transcript JSON, question state, and generated rationale; none may contain them. A non-Guardian request must still produce ordinary debug capture. The sensitive path emits only bounded reason codes, strategy, correlation ID, safe target IDs/status, timing, and usage. Test a missing or disabled saved Provider gives an actionable code with safe IDs but still falls back while live.

```ts
const leaked = JSON.stringify({ logs, traces, captures });
expect(leaked).not.toContain('GUARDIAN_SENTINEL_7fbc4e');
expect(leaked).not.toContain('pending_action');
```

- [ ] **Step 4: Run `rtk bun test packages/server/src/routes/pipeline/guardian-integration.test.ts packages/plugins/openai-chatgpt/src/runtime/guardian/guardian.test.ts` and `rtk bun run check`; fix only failures these tests reveal.** Commit with `test(server): cover guardian review lifecycle and privacy` and the required coauthor footer.

### Task 11: Render conditional Provider and model controls in the dashboard

**Files:**
- Create: `packages/dashboard/src/lib/provider-summaries-query.ts`
- Modify: `packages/dashboard/src/modules/providers/services/providers-query/providers-query.ts` (re-export the shared query)
- Create: `packages/dashboard/src/modules/plugins/components/plugin-provider-options-field.tsx`
- Create: `packages/dashboard/src/modules/plugins/components/plugin-provider-model-options-field.tsx`
- Modify: `packages/dashboard/src/modules/plugins/components/plugin-options-field.tsx`
- Modify: `packages/dashboard/src/modules/plugins/components/plugin-options-drawer.tsx`
- Modify: `packages/dashboard/src/modules/plugins/hooks/use-plugin-options-form.ts`
- Modify: `packages/i18n/messages/en.json`, `ja.json`, `ko.json`, `zh-Hans.json`, `zh-Hant.json`
- Test: `packages/dashboard/src/modules/plugins/templates/plugins-page/plugins-page.test.tsx`

**Interfaces:**
- Consumes: Task 1's generic form descriptor, Task 3's plugin setting keys, the existing typed `/dashboard/api/providers` response (`id`, `name`, `enabled`, `kind`, `protocols`, `clientModels`, `state`), and existing `queryKeys.providers`.
- Produces: generic Provider selector and model-ID suggestion input usable by any plugin form; only the ChatGPT descriptor decides when they appear. No new dashboard endpoint or cross-module import.

- [ ] **Step 1: Add failing page-level tests for the form.** In `default`, Provider/model controls are hidden. In either System One strategy, both appear and show the context-disclosure description. List a compatible enabled `api` Provider with a `typesafe-systemone` protocol, an enabled `ai-sdk` Provider whose runtime support is unknown, and an incompatible Provider; only the first two are selectable. Labels show display name **and stable Provider ID**. Selecting a Provider offers its `clientModels`; manual model text is accepted. A saved disabled/deleted Provider remains visible as invalid and blocks an active-mode save until corrected or switched to `default`. Switching Provider clears an incompatible model draft. Assert saved IDs are stored, never the display name.

```tsx
await userEvent.click(screen.getByRole('button', { name: /Guardian review strategy/i }));
await userEvent.click(screen.getByText('System One'));
expect(screen.getByLabelText(/Evaluation Provider/i)).toBeVisible();
expect(screen.getByLabelText(/Model ID/i)).toBeVisible();
expect(screen.getByText(/system-one-local/)).toBeVisible();
```

- [ ] **Step 2: Run `rtk bun test packages/dashboard/src/modules/plugins/templates/plugins-page/plugins-page.test.tsx`; expect the new control tests to fail.**
- [ ] **Step 3: Move the existing Provider query implementation to `src/lib/provider-summaries-query.ts` so both modules use the same TanStack Query key and typed Hono client.** Re-export from the Providers module's old service path to preserve its callers. In `PluginOptionsDrawer`, call `useQuery(providerSummariesQueryOptions())` only while the drawer contains a `provider` field; pass summaries to the generic field renderer. In `PluginOptionsField`, evaluate `equals` or `notEquals` and delegate the two new field variants to one component each. Use shadcn `Select` for Provider IDs and shadcn `Input` with a native `<datalist>` for suggested model IDs plus manual entry. Both controls write through the existing TanStack Form field API. Do not import a Providers module file from Plugins.

```ts
const selectable = providers.filter((provider) =>
  provider.enabled && provider.state.status === 'ready' &&
  (provider.protocols.includes('typesafe-systemone') || provider.kind === 'ai-sdk')
);
const label = (provider: DashboardProviderSummary) => `${provider.name ?? provider.id} (${provider.id})`;
```

- [ ] **Step 4: Make active-mode form submission refuse a missing, disabled, deleted, or known-incompatible selected Provider, and a blank model ID; keep the saved invalid ID displayed with a localized error.** The server's option schema still validates exact nonempty IDs, while runtime exact-route validation handles later changes and unknown `ai-sdk` support. Add every new dashboard message to all five locales and run `rtk bun run i18n:compile`.

```ts
const targetValid = strategy === 'default' ||
  (selectable.some((provider) => provider.id === providerId) && modelId.trim().length > 0);
if (!targetValid) return;
```

- [ ] **Step 5: Run `rtk bun test packages/dashboard/src/modules/plugins/templates/plugins-page/plugins-page.test.tsx packages/dashboard/src/modules/providers/services/providers-query/providers-query.test.ts`, `rtk bun run i18n:compile`, and `rtk bun run check`.** Commit with `feat(dashboard): choose guardian evaluation provider` and the required coauthor footer.

### Task 12: Verify the supported consumer and ship one coherent changeset

**Files:**
- Modify: `docs/superpowers/specs/2026-09-23-guardian-system-one-review-design.md` when the verified Codex consumer requires a response-shape correction; otherwise leave it unchanged
- Create: one `.changeset/*.md` covering the shipped user-facing feature
- Test: `packages/server/src/routes/pipeline/guardian-integration.test.ts` and the focused plugin/dashboard tests from earlier tasks

**Interfaces:**
- Consumes: all tasks above. The public `/v1/systemone` wire protocol and `/v1/responses` route signatures are unchanged.
- Produces: a tested optional Guardian strategy and a release note. This task does not implement the user's separate catalog fix for `codex-auto-review`.

- [ ] **Step 1: Run the synthetic local smoke test against `http://127.0.0.1:9317/v1/` if the configured local server is running.** Use a sanitized Guardian request and the selected local System One Provider; no API key is added when the local instance accepts anonymous callers. Verify the selected model is reached, the response has exactly one `allow`/`deny`, and the supported Codex consumer parses both JSON and SSE. If port 9317 is down, run the same fixture against an ephemeral local `createServer` test instance and record that the external daemon was unavailable; do not claim a live-daemon result. Never replay or upload the large private attachment.

```bash
rtk curl --silent --show-error --max-time 4 http://127.0.0.1:9317/v1/models
rtk bun test packages/server/src/routes/pipeline/guardian-integration.test.ts
```

- [ ] **Step 2: Run the full gate from a built tree.** Execute `rtk bun run build`, then `rtk bun run preflight`; require type-aware lint, format, unit tests, and artifact tests to pass. If the consumer rejects the synthetic profile, update the Responses writer to match a verified fixture and repeat the focused tests and gate. Check a Provider reload, disabled target, both strategies, direct allow/deny, timeout, and cancellation once more in the integration test.
- [ ] **Step 3: Author one short changeset via `rtk bun changeset`.** Mark `aio-proxy` and `@aio-proxy/plugin-sdk` as `minor`, and list each changed internal package at the same level (`@aio-proxy/core`, `@aio-proxy/types`, `@aio-proxy/server`, `@aio-proxy/plugin-openai-chatgpt`, `@aio-proxy/cli`, `@aio-proxy/dashboard`, `@aio-proxy/i18n`). Use one paragraph, at most five lines, describing the optional Guardian strategies, selected Provider/model, and safe fallback; no implementation file names or interim defects. Inspect existing pending changesets for a stale note about this exact behavior and rewrite it instead of appending a second note.

```md
---
"aio-proxy": minor
"@aio-proxy/plugin-sdk": minor
"@aio-proxy/core": minor
"@aio-proxy/types": minor
"@aio-proxy/server": minor
"@aio-proxy/plugin-openai-chatgpt": minor
"@aio-proxy/cli": minor
"@aio-proxy/dashboard": minor
"@aio-proxy/i18n": minor
---

ChatGPT OAuth now offers optional Guardian approval strategies that evaluate with a selected System One Provider and model. The default keeps Codex behavior, and supported System One decisions can be final or send denials to the original model for review; unavailable evaluations fall back safely.
```

- [ ] **Step 4: Review `rtk git status --short`, `rtk git diff --check`, and the staged diff; exclude the user's pre-existing `bun.lock` edit.** Commit the changeset and any verified final fixes with a Conventional Commit message and the required coauthor footer. Do not create a PR unless the user asks.
