# Provider Request Transforms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CPA-aligned, per-Provider request header and JSON-body transforms with one canonical Mongo-style AST editable through JSON or a visual Dashboard editor.

**Architecture:** Validate the restricted AST once in `@aio-proxy/types`, compile it with Mingo in `@aio-proxy/server`, and decorate only attempt-scoped model Fetch calls before the existing observed/proxy Fetch chain. The Dashboard edits the same AST using React Query Builder codecs and TanStack Form; no script runtime, FFI, response transform, or dry-run subsystem is introduced.

**Tech Stack:** Bun 1.3.14, TypeScript 7, Zod 4.4.3, Mingo 7.2.2, React 19, TanStack Form, React Query Builder 8.21.2, Monaco, Rstest, `bun:test`.

## Global Constraints

- V1 supports only Provider-scoped request headers and JSON request bodies; do not accept response transforms.
- Rules run in configuration order against the current request, apply immediately, and use last-write-wins semantics.
- Keep the immutable original request outside Mingo; clone original and current separately before every update stage.
- Permit only the documented query, expression, `$set`, and `$unset` profile; reject `$where`, `$function`, prototype paths, and every unsupported operator.
- General regex remains supported with flags limited to `i`, `m`, `s`, and `u`; CPA Pattern uses `*` as the only wildcard.
- Header conditions use generated `$expr`/`$getField` shapes; Header Pattern and Regex additionally use `$regexMatch`, while Header Exists/Does not exist use generated `$ifNull` comparisons with `null`.
- Header Set and Remove use one `$setField` or `$unsetField` rooted directly at `$request.headers`.
- A user rule may not add, remove, or change a connection-managed header; an unchanged existing header remains valid.
- Transform failures contain only a safe code plus rule/stage coordinates, send no request for that Provider attempt, and use the existing Provider fallback loop.
- Fetch order is transform → observed/wire logging → proxy/runtime Fetch.
- Decorate only per-Provider model Fetch; OAuth authorization, catalog, quota, refresh, and other auxiliary Fetch calls remain untouched.
- Mingo remains server-only. Do not add Node-API, WASM, native libraries, Bun FFI, arbitrary JavaScript, or a second expression engine.
- Keep the existing Ubuntu release job and four Bun cross-compiled CLI targets unchanged.
- Dashboard forms use TanStack Form and shared Zod schemas; all user-facing copy comes from `@aio-proxy/i18n`.
- Use the existing shadcn/Base UI primitives. Adapt the official React Query Builder shadcn registry source pinned at commit `389b271cadc54080d4ad096d5b3ab57db5d688c4`; do not add another UI framework.
- Reorder rules and stages with accessible Move Up/Move Down buttons; do not add a drag-and-drop dependency.
- Keep handwritten non-test implementation files below 300 lines and reassess splitting at 240 lines.
- Every repository shell command in this plan is prefixed with `rtk`.

## File Map

### Shared schemas

- `packages/types/src/provider-transform/index.ts`: export-only entry point.
- `packages/types/src/provider-transform/provider-transform.ts`: structural schemas, semantic validator, JSON Schema, and public transform types.
- `packages/types/src/provider-transform/provider-transform.test.ts`: accepted/rejected profile behavior.
- `packages/types/src/provider.ts`: add `transforms` to all Provider and mutation schemas.
- `packages/types/src/dashboard-oauth.ts`: allow transforms in OAuth Provider patches.
- `packages/types/src/index.ts`: export the transform module.
- `packages/server/src/dashboard-routes/provider-mutation/index.ts`: export-only entry point preserving existing imports.
- `packages/server/src/dashboard-routes/provider-mutation/provider-mutation.ts`: preserve existing transforms when an update omits the field.
- `packages/server/src/dashboard-routes/provider-mutation/provider-mutation.test.ts`: mutation preservation/clearing behavior.

### Server engine and integration

- `packages/server/src/provider-request-transform/index.ts`: export-only entry point.
- `packages/server/src/provider-request-transform/compile.ts`: compile queries and record body references.
- `packages/server/src/provider-request-transform/evaluate.ts`: sequential Mingo evaluation and detached snapshots.
- `packages/server/src/provider-request-transform/error.ts`: sanitized runtime error and diagnostic extraction.
- `packages/server/src/provider-request-transform/fetch.ts`: lazy body materialization, Request reconstruction, and Fetch decoration.
- `packages/server/src/provider-request-transform/*.test.ts`: engine and Fetch contracts.
- `packages/server/src/request-logging/context.ts`: expose optional attempt protocol metadata from the existing AsyncLocalStorage.
- `packages/server/src/routes/pipeline/attempt/context.ts`: pass target protocol into the attempt scope.
- `packages/server/src/routes/pipeline/attempt/attempt.ts`: add requested/source/target protocol metadata to model attempts.
- `packages/server/src/routes/pipeline/attempt/model.ts`: enter the attempt scope with the resolved model target protocol.
- `packages/server/src/routes/pipeline/attempt/raw.ts`: enter the attempt scope with the inbound/raw target protocol.
- `packages/server/src/provider-runtime/materialize.ts`: compose transform → observed → proxy Fetch for API and AI SDK Providers.
- `packages/server/src/server-state/snapshot.ts`: decorate each OAuth Provider's `modelFetch`, not `runtimeFetch`.
- `packages/server/src/routes/pipeline/logging.ts`: attach sanitized transform coordinates to attempt-failure logs.
- `packages/server/src/server-log.ts`: type the sanitized transform diagnostic fields.
- Existing adjacent tests cover raw, bridged, direct AI SDK, OAuth, observed logging, and fallback paths.

### Dashboard editor

- `packages/dashboard/src/modules/providers/request-transforms/mongo-codec.ts`: condition/expression Mongo AST codecs.
- `packages/dashboard/src/modules/providers/request-transforms/stage-codec.ts`: visual Set/Remove stage codecs.
- `packages/dashboard/src/modules/providers/request-transforms/pattern.ts`: CPA wildcard conversion.
- `packages/dashboard/src/modules/providers/request-transforms/*.test.ts`: lossless canonical round trips.
- `packages/dashboard/src/modules/providers/components/provider-request-transforms/`: JSON/visual editor and adapted query-builder controls, one component per `.tsx` file.
- Existing Provider form hooks, fields, templates, and OAuth edit service carry the shared `transforms` value and validity.
- `packages/i18n/messages/en.json` and `packages/i18n/messages/zh-Hans.json`: all editor labels, help, actions, and errors.

---

### Task 1: Define and plumb the restricted transform AST

**Files:**

- Create: `packages/types/src/provider-transform/index.ts`
- Create: `packages/types/src/provider-transform/provider-transform.ts`
- Create: `packages/types/src/provider-transform/provider-transform.test.ts`
- Modify: `packages/types/src/provider.ts`
- Modify: `packages/types/src/dashboard-oauth.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/types/src/config/config.test.ts`
- Move: `packages/server/src/dashboard-routes/provider-mutation.ts` → `packages/server/src/dashboard-routes/provider-mutation/provider-mutation.ts`
- Create: `packages/server/src/dashboard-routes/provider-mutation/index.ts`
- Create: `packages/server/src/dashboard-routes/provider-mutation/provider-mutation.test.ts`

**Interfaces:**

- Produces `ProviderRequestTransformRuleSchema` and `ProviderRequestTransformRulesSchema`.
- Produces `ProviderTransformsSchema` with only `request` accepted in V1.
- Produces `ProviderRequestTransformRulesJsonSchema` for Monaco.
- Produces `ProviderRequestTransformRule`, `ProviderRequestTransformStage`, and `ProviderTransforms` types.
- Adds `transforms?: ProviderTransforms` to API, AI SDK, OAuth, authoring, and mutation bodies.

- [ ] **Step 1: Write failing profile tests**

Create table-driven tests that accept the CPA-ordering sample and canonical header operations:

```ts
const valid = {
  request: [
    {
      name: 'cap-output',
      when: {
        $and: [
          { 'request.model': { $regex: '^gpt-' } },
          { $expr: { $gt: ['$request.body.max_output_tokens', 8192] } },
        ],
      },
      update: [
        { $set: { 'request.body.max_output_tokens': { $min: ['$request.body.max_output_tokens', 8192] } } },
        {
          $set: {
            'request.headers': {
              $setField: {
                field: 'x-upstream-model',
                input: '$request.headers',
                value: '$request.body.model',
              },
            },
          },
        },
        { $unset: 'request.body.store' },
      ],
    },
  ],
};

expect(ProviderTransformsSchema.parse(valid)).toEqual(valid);
```

Reject each unsupported or ambiguous form with its exact issue path:

```ts
const invalidCases = [
  [{ request: [{ when: { $where: 'return true' }, update: [{ $unset: 'request.body.x' }] }] }, ['request', 0, 'when', '$where']],
  [{ request: [{ update: [{ $set: { 'request.body.a': 1, 'request.body.b': 2 } }] }] }, ['request', 0, 'update', 0, '$set']],
  [{ request: [{ update: [{ $unset: ['request.body.a'] }] }] }, ['request', 0, 'update', 0, '$unset']],
  [{ request: [{ update: [{ $set: { 'request.headers.x.test': 'x' } }] }] }, ['request', 0, 'update', 0, '$set']],
  [{ request: [{ update: [{ $set: { 'request.url': 'https://evil.test' } }] }] }, ['request', 0, 'update', 0, '$set']],
  [{ request: [{ update: [{ $unset: 'request.body.__proto__.polluted' }] }] }, ['request', 0, 'update', 0, '$unset']],
];
```

Also assert:

- `$regex` accepts JSON strings and `$options` values composed only of unique `i`, `m`, `s`, `u` characters;
- `$expr` accepts only the documented functions and exact arities;
- `$getField` is accepted only as a generated Header-field leaf with a literal HTTP header name and input `$request.headers` or `$original.headers`; `$regexMatch` is accepted only in generated Header Pattern/Regex conditions;
- Header Exists/Does not exist are accepted only as `$expr` comparisons between `null` and `{ $ifNull: [<generated $getField>, null] }`;
- `$setField`/`$unsetField` are accepted only as the sole value of a `$set` targeting `request.headers`;
- header names use HTTP token syntax and lowercase normalization; connection-managed names remain structurally valid so the runtime can allow a final unchanged value and reject only an actual before/after modification;
- `response` under `transforms` is rejected;
- the generated JSON Schema describes an array of rule objects with non-empty `update` arrays.

- [ ] **Step 2: Verify RED**

Run:

```bash
rtk bun test packages/types/src/provider-transform/provider-transform.test.ts
```

Expected: FAIL because the transform module does not exist.

- [ ] **Step 3: Implement structural schemas and semantic walking**

Use JSON-safe documents structurally, then one `superRefine` walker for the restricted profile:

```ts
const MongoDocumentSchema = z.record(z.string(), z.json());

export const ProviderRequestTransformRuleSchema = z.strictObject({
  name: z.string().min(1).optional(),
  when: MongoDocumentSchema.optional(),
  update: z.array(MongoDocumentSchema).min(1),
});

export const ProviderRequestTransformRulesSchema = z
  .array(ProviderRequestTransformRuleSchema)
  .superRefine(validateRequestTransformRules);

export const ProviderTransformsSchema = z.strictObject({
  request: ProviderRequestTransformRulesSchema,
});

export const ProviderRequestTransformRulesJsonSchema = z.toJSONSchema(
  ProviderRequestTransformRulesSchema,
  { io: 'input' },
);
```

Keep validator helpers private in the same file. Use `context.addIssue({ code: 'custom', path, message })` with these stable messages:

```ts
const issue = {
  queryOperator: 'REQUEST_TRANSFORM_QUERY_OPERATOR_UNSUPPORTED',
  expressionOperator: 'REQUEST_TRANSFORM_EXPRESSION_OPERATOR_UNSUPPORTED',
  expressionArity: 'REQUEST_TRANSFORM_EXPRESSION_ARITY_INVALID',
  regex: 'REQUEST_TRANSFORM_REGEX_INVALID',
  stage: 'REQUEST_TRANSFORM_STAGE_INVALID',
  target: 'REQUEST_TRANSFORM_TARGET_INVALID',
  path: 'REQUEST_TRANSFORM_PATH_UNSAFE',
  header: 'REQUEST_TRANSFORM_HEADER_INVALID',
} as const;
```

Canonical expression arities are exact so JSON and Visual modes have the same domain:

```ts
const expressionArity = {
  $add: [2, 2],
  $subtract: [2, 2],
  $multiply: [2, 2],
  $divide: [2, 2],
  $mod: [2, 2],
  $min: [2, Infinity],
  $max: [2, Infinity],
  $abs: [1, 1],
  $concat: [2, Infinity],
  $toUpper: [1, 1],
  $toLower: [1, 1],
  $cond: [3, 3],
  $ifNull: [2, 2],
  $concatArrays: [2, Infinity],
  $mergeObjects: [2, Infinity],
} as const;
```

Treat `$literal` as a unary wrapper whose payload is any JSON value. Field-reference strings may start only with `$provider.`, `$request.`, or `$original.`. Reject `__proto__`, `constructor`, and `prototype` in every dotted query, expression, and update path.

For every `$regex`, validate syntax with `new RegExp(pattern, options)` after checking the flag alphabet. This rejects malformed patterns and duplicate flags without restricting valid general regex content or adding a timeout/alternate engine.

- [ ] **Step 4: Add Provider schema and mutation plumbing**

Add the field to `SharedProviderSchemaBase`, both API/AI SDK mutation shared-field objects, and `OAuthProviderMutationBodySchema`:

```ts
transforms: ProviderTransformsSchema.optional().describe('Ordered outbound request transforms.'),
```

Add `transforms` to `DashboardOAuthProviderPatchSchema`. Export the module from `packages/types/src/index.ts`:

```ts
export * from './provider-transform/index';
```

In `replaceProvider`, preserve the stored field when an older or partial client omits it; clearing is represented explicitly as `{ request: [] }`:

```ts
for (const key of ['headers', 'proxy', 'transforms'] as const) {
  if (provider[key] === undefined && previous[key] !== undefined) next[key] = previous[key];
}
```

Extend config and mutation tests to prove all three Provider kinds parse transforms, materialized mutation validation reruns after template expansion, omission preserves existing transforms, and `{ request: [] }` clears them.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
rtk bun test packages/types/src/provider-transform/provider-transform.test.ts packages/types/src/config/config.test.ts packages/server/src/dashboard-routes/provider-mutation/provider-mutation.test.ts
rtk bun run --filter @aio-proxy/types build
```

Expected: all commands PASS.

```bash
rtk git add packages/types/src/provider-transform packages/types/src/provider.ts packages/types/src/dashboard-oauth.ts packages/types/src/index.ts packages/types/src/config/config.test.ts packages/server/src/dashboard-routes/provider-mutation
rtk git commit -m "feat(types): define provider request transforms" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Compile and evaluate transforms with Mingo

**Files:**

- Modify: `packages/server/package.json`
- Modify: `bun.lock`
- Create: `packages/server/src/provider-request-transform/index.ts`
- Create: `packages/server/src/provider-request-transform/compile.ts`
- Create: `packages/server/src/provider-request-transform/compile.test.ts`
- Create: `packages/server/src/provider-request-transform/evaluate.ts`
- Create: `packages/server/src/provider-request-transform/evaluate.test.ts`
- Create: `packages/server/src/provider-request-transform/error.ts`

**Interfaces:**

- Produces `compileProviderRequestTransforms(rules): CompiledProviderRequestTransforms`.
- Produces `evaluateProviderRequestTransforms(compiled, input, loadBody): Promise<ProviderRequestTransformResult>`.
- Produces `ProviderRequestTransformError` and `providerRequestTransformDiagnostic(error)`.
- `CompiledProviderRequestTransforms` exposes per-rule/per-stage body-reference and generated Header-target metadata without exposing Mingo types outside this directory.
- `ProviderRequestTransformResult` includes `lastAppliedLocation` and the last write location for each Header name, so post-pipeline reconstruction errors retain safe coordinates.

- [ ] **Step 1: Add the server-only dependency**

Run:

```bash
rtk bun add --cwd packages/server mingo@7.2.2
```

Expected: only `packages/server/package.json` and `bun.lock` change; the Dashboard does not depend on Mingo.

- [ ] **Step 2: Write failing compile and evaluation tests**

Cover compiled metadata and CPA sequencing:

```ts
const compiled = compileProviderRequestTransforms([
  {
    when: { 'request.model': { $regex: '^gpt-' } },
    update: [{ $set: { 'request.headers': headerSet('x-route', 'first') } }],
  },
  {
    when: { $expr: { $eq: [headerGet('request', 'x-route'), 'first'] } },
    update: [
      { $set: { 'request.body.limit': { $min: ['$request.body.limit', 10] } } },
      { $set: { 'request.body.route': '$original.body.route' } },
      { $set: { 'request.headers': headerSet('x-route', 'last') } },
    ],
  },
]);

const output = await evaluateProviderRequestTransforms(compiled, fixture({
  headers: {},
}), async () => ({ limit: 20, route: { name: 'original' } }));

expect(output.request.body).toEqual({ limit: 10, route: { name: 'original' } });
expect(output.request.headers['x-route']).toBe('last');
expect(output.bodyLoaded).toBe(true);
expect(output.bodyModified).toBe(true);
```

Add a reference-isolation regression:

```ts
const output = await evaluateProviderRequestTransforms(
  compileProviderRequestTransforms([
    {
      update: [
        { $set: { 'request.body.copy': '$original.body.nested' } },
        { $set: { 'request.body.copy.value': 2 } },
        { $set: { 'request.body.originalValue': '$original.body.nested.value' } },
      ],
    },
  ]),
  fixture(),
  async () => ({ nested: { value: 1 } }),
);

expect(output.request.body).toEqual({
  nested: { value: 1 },
  copy: { value: 2 },
  originalValue: 1,
});
```

Also assert expression type failures return an error with only `code`, `ruleIndex`, optional `ruleName`, and optional `stageIndex`; the error has the generic message `Provider request transform failed` and no `cause`.

Add query behavior cases for `$and`, `$or`, `$nor`, field-level `$not`, `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$regex`, and `$expr`. Verify a missing field does not satisfy ordinary comparisons and does satisfy `{ $exists: false }`.

- [ ] **Step 3: Verify RED**

Run:

```bash
rtk bun test packages/server/src/provider-request-transform/compile.test.ts packages/server/src/provider-request-transform/evaluate.test.ts
```

Expected: FAIL because the engine modules do not exist.

- [ ] **Step 4: Implement compilation and body-reference analysis**

Use Mingo's top-level exports and fixed options:

```ts
import { Query } from 'mingo';

const MINGO_OPTIONS = { scriptEnabled: false, failOnError: true } as const;

export function compileProviderRequestTransforms(
  rules: readonly ProviderRequestTransformRule[],
): CompiledProviderRequestTransforms {
  return {
    readsBody: rules.some(ruleReadsBody),
    rules: rules.map((rule, ruleIndex) => ({
      ruleIndex,
      name: rule.name,
      query: new Query(rule.when ?? {}, MINGO_OPTIONS),
      whenReadsBody: referencesBody(rule.when),
      stages: rule.update.map((stage, stageIndex) => ({
        document: stage,
        stageIndex,
        readsBody: referencesBody(stage),
        writesBody: stageTargetsBody(stage),
        headerTarget: generatedHeaderTarget(stage),
      })),
    })),
  };
}
```

The recursive analyzer treats both string references (`$request.body...`, `$original.body...`) and query/update keys rooted at `request.body` or `original.body` as body references. It must not classify `request.headers` or a static `$literal` payload as a body reference.

- [ ] **Step 5: Implement detached sequential evaluation**

Use an async lazy body loader plus `updateOne` with one stage at a time:

```ts
import { updateOne } from 'mingo';

let original = input.request;
let current = input.request;
let bodyLoaded = false;
let bodyModified = false;
let lastAppliedLocation: ProviderRequestTransformLocation | undefined;
const headerWriteLocations = new Map<string, ProviderRequestTransformLocation>();

const ensureBody = async (location: ProviderRequestTransformLocation) => {
  if (bodyLoaded) return;
  const body = await loadBody(location);
  original = { ...original, body: structuredClone(body) };
  current = { ...current, body: structuredClone(body) };
  bodyLoaded = true;
};

for (const rule of compiled.rules) {
  const ruleLocation = {
    ruleIndex: rule.ruleIndex,
    ...(rule.name === undefined ? {} : { ruleName: rule.name }),
  };
  if (rule.whenReadsBody) await ensureBody(ruleLocation);
  const conditionDocument = evaluationDocument(provider, original, current);
  let matched: boolean;
  try {
    matched = rule.query.test(conditionDocument);
  } catch {
    throw new ProviderRequestTransformError({
      code: 'REQUEST_TRANSFORM_EVALUATION_FAILED',
      ...ruleLocation,
    });
  }
  if (!matched) continue;

  for (const stage of rule.stages) {
    const location = { ...ruleLocation, stageIndex: stage.stageIndex };
    if (stage.readsBody || stage.writesBody) await ensureBody(location);
    const stageDocument = evaluationDocument(provider, original, current);
    try {
      updateOne([stageDocument], {}, [stage.document], undefined, MINGO_OPTIONS);
      current = structuredClone(stageDocument.request);
      bodyModified ||= stage.writesBody;
      lastAppliedLocation = location;
      if (stage.headerTarget !== undefined) headerWriteLocations.set(stage.headerTarget, location);
    } catch {
      throw new ProviderRequestTransformError({
        code: 'REQUEST_TRANSFORM_EVALUATION_FAILED',
        ...location,
      });
    }
  }
}

return { request: current, bodyLoaded, bodyModified, lastAppliedLocation, headerWriteLocations };
```

`loadBody(location)` is called at most once by the Fetch implementation and receives the first rule/stage coordinates that require it. `evaluationDocument()` must call `structuredClone(original)` and `structuredClone(current)` separately every time. Never retain `stageDocument.original`, `stageDocument.request`, or any Mingo-returned object after the stage.

Define only these runtime codes:

```ts
export type ProviderRequestTransformErrorCode =
  | 'REQUEST_TRANSFORM_BODY_NOT_JSON'
  | 'REQUEST_TRANSFORM_BODY_PARSE_FAILED'
  | 'REQUEST_TRANSFORM_EVALUATION_FAILED'
  | 'REQUEST_TRANSFORM_REQUEST_REBUILD_FAILED'
  | 'REQUEST_TRANSFORM_HEADER_FORBIDDEN';
```

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
rtk bun test packages/server/src/provider-request-transform/compile.test.ts packages/server/src/provider-request-transform/evaluate.test.ts
rtk bun run --filter @aio-proxy/server test:unit -- src/provider-request-transform
```

Expected: PASS.

```bash
rtk git add packages/server/package.json bun.lock packages/server/src/provider-request-transform
rtk git commit -m "feat(server): evaluate provider request transforms" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Decorate Provider model Fetch and preserve fallback/logging semantics

**Files:**

- Create: `packages/server/src/provider-request-transform/fetch.ts`
- Create: `packages/server/src/provider-request-transform/fetch.test.ts`
- Modify: `packages/server/src/provider-request-transform/index.ts`
- Modify: `packages/server/src/request-logging/context.ts`
- Modify: `packages/server/src/request-logging/context.test.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/context.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/model.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/raw.ts`
- Modify: `packages/server/src/provider-runtime/materialize.ts`
- Modify: `packages/server/src/provider-runtime/materialize.test.ts`
- Modify: `packages/server/src/provider-runtime/observed-fetch.test.ts`
- Modify: `packages/server/src/plugin-runtime/host-fetch-context.test.ts`
- Modify: `packages/server/src/server-state/snapshot.ts`
- Modify: `packages/server/src/routes/pipeline/logging.ts`
- Modify: `packages/server/src/server-log.ts`
- Modify: `packages/server/src/routes/pipeline/raw-fallback.exceptions.test.ts`

**Interfaces:**

- Produces `createProviderRequestTransformFetch(provider, fetcher): typeof globalThis.fetch`.
- Produces `currentProviderAttemptContext(): ProviderAttemptContext | undefined` from the existing request-log scope.
- Changes `CandidateSlot.inAttempt` to `(targetProtocol, operation) => result`.
- Adds optional `transformRuleIndex`, `transformRuleName`, and `transformStageIndex` to `request.provider_attempt_failed` logs.

- [ ] **Step 1: Write failing Fetch-boundary tests**

Cover these contracts in `fetch.test.ts`:

```ts
// No complete model-attempt metadata: exact passthrough for probes and auxiliary calls.
expect(baseCalls[0]?.input).toBe(originalInput);
expect(baseCalls[0]?.init).toBe(originalInit);

// Header-only transform: the body stream is never cloned, read, or replaced.
expect(bodyPulls).toBe(0);
expect(sent.headers.get('x-provider-route')).toBe('primary');

// Body-aware transform: parse once, serialize once, and drop stale length.
expect(bodyReads).toBe(1);
expect(await sent.json()).toEqual({ limit: 10 });
expect(sent.headers.has('content-length')).toBe(false);

// Literal-dot header names survive generated $setField/$unsetField operations.
expect(sent.headers.get('x.aio.route')).toBe('blue');

// Bun-specific Fetch extension survives Request reconstruction.
expect(baseCalls[0]?.init).toEqual({ decompress: false });
```

Also assert:

- a body-referencing rule rejects non-JSON content before the base Fetch runs;
- a matched body update on malformed JSON produces `REQUEST_TRANSFORM_BODY_PARSE_FAILED`;
- unchanged incoming `host` survives, while an attempted change/removal produces `REQUEST_TRANSFORM_HEADER_FORBIDDEN`;
- body-independent conditions run before a body is parsed;
- a body-dependent update parses only after its body-independent condition matches;
- reconstructing a Request failure is wrapped without its original message or operands.

- [ ] **Step 2: Write failing integration tests**

Extend existing tests to prove:

1. raw API passthrough sends transformed headers/body;
2. API-to-AI-SDK bridge uses the same transformed Fetch;
3. direct AI SDK Provider uses the transformed Fetch;
4. OAuth `context.modelFetch` is transformed while `context.fetch` remains byte-for-byte unchanged;
5. `request.upstream_snapshot` and reconstructed upstream body logs contain the transformed request;
6. a transform exception makes zero calls to that Provider's base Fetch, logs only safe coordinates, and falls back to the next candidate.

The fallback assertion must inspect the emitted event rather than the error message:

```ts
expect(logs).toContainEqual(
  expect.objectContaining({
    event: 'request.provider_attempt_failed',
    providerId: 'broken',
    failureKind: 'exception',
    fallback: true,
    exceptionCode: 'REQUEST_TRANSFORM_EVALUATION_FAILED',
    transformRuleIndex: 0,
    transformRuleName: 'broken-rule',
    transformStageIndex: 0,
  }),
);
expect(JSON.stringify(logs)).not.toContain('secret-operand');
```

- [ ] **Step 3: Verify RED**

Run:

```bash
rtk bun test packages/server/src/provider-request-transform/fetch.test.ts packages/server/src/provider-runtime/materialize.test.ts packages/server/src/provider-runtime/observed-fetch.test.ts packages/server/src/plugin-runtime/host-fetch-context.test.ts packages/server/src/routes/pipeline/raw-fallback.exceptions.test.ts
```

Expected: FAIL because the Fetch decorator and attempt metadata are not wired.

- [ ] **Step 4: Extend the existing attempt context without creating another store**

Keep current correlation fields unchanged and add optional model-request metadata:

```ts
export type ProviderAttemptContext = {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedModelId: string;
  readonly sourceProtocol: ProviderProtocol;
  readonly targetProtocol?: ProviderProtocol;
};

export type AttemptLogContext = Required<Omit<RequestLogContext, 'requestId'>> &
  Partial<Omit<ProviderAttemptContext, 'providerId' | 'modelId'>>;

export function currentProviderAttemptContext(): ProviderAttemptContext | undefined {
  const scope = storage.getStore();
  if (
    scope?.providerId === undefined ||
    scope.modelId === undefined ||
    scope.requestedModelId === undefined ||
    scope.sourceProtocol === undefined
  ) return undefined;
  return {
    providerId: scope.providerId,
    modelId: scope.modelId,
    requestedModelId: scope.requestedModelId,
    sourceProtocol: scope.sourceProtocol,
    ...(scope.targetProtocol === undefined ? {} : { targetProtocol: scope.targetProtocol }),
  };
}
```

Do not add these protocol fields to `currentRequestLogContext()`, so existing bridge log payloads remain unchanged.

Change the slot function to accept the resolved protocol:

```ts
readonly inAttempt: <T>(targetProtocol: ProviderProtocol | undefined, operation: () => T) => T;
```

Build its scope in `attempt.ts` with `requestedModelId` and `adapter.protocol`. Call it with `adapter.protocol` in `raw.ts` and with `targetProtocol` in `model.ts`. Existing probe and token-count scopes do not provide the complete metadata, so the transform wrapper passes through.

- [ ] **Step 5: Implement lazy body handling and Request reconstruction**

Use the active attempt plus Provider config to build the evaluation request:

```ts
const attempt = currentProviderAttemptContext();
if (attempt === undefined || attempt.providerId !== provider.id || compiled.rules.length === 0) {
  return fetcher(input, init);
}

const request = new Request(input, init);
const headers = Object.fromEntries([...request.headers].map(([name, value]) => [name.toLowerCase(), value]));
```

Rules receive:

```ts
{
  provider: { id: provider.id, kind: provider.kind, ...(provider.protocol ? { protocol: provider.protocol } : {}) },
  request: {
    model: attempt.modelId,
    requestedModel: attempt.requestedModelId,
    sourceProtocol: attempt.sourceProtocol,
    ...(attempt.targetProtocol === undefined ? {} : { targetProtocol: attempt.targetProtocol }),
    method: request.method,
    url: request.url,
    headers,
  },
}
```

Pass `evaluateProviderRequestTransforms()` a memoized `loadBody(location)` closure. It uses `request.clone().text()` for the single lazy body read, accepts media types whose normalized type is `application/json` or ends in `+json`, and throws `ProviderRequestTransformError` with the supplied location plus `REQUEST_TRANSFORM_BODY_NOT_JSON` or `REQUEST_TRANSFORM_BODY_PARSE_FAILED`. Parse at most once and reuse the parsed value for every rule. Preserve the original Request/body stream when `bodyModified` is false; when true, serialize `result.request.body` once with `JSON.stringify`.

After evaluation, construct one `Headers` instance from the resulting entries so Fetch validates names, coerces computed values to strings, normalizes case, and applies combined-value behavior. Compare every connection-managed header in the normalized pre-transform and user-result `Headers` objects. Reject only an added, removed, or changed value, using `result.headerWriteLocations.get(name)` for the error coordinates. After that comparison succeeds, delete `content-length` only when `bodyModified` is true; this deletion is engine-owned and must not be mistaken for a user modification. Wrap Request/Headers reconstruction errors with `result.lastAppliedLocation` and `REQUEST_TRANSFORM_REQUEST_REBUILD_FAILED`.

Preserve Bun's extension exactly as the observed wrapper does:

```ts
const decompress = (init as (RequestInit & { decompress?: boolean }) | undefined)?.decompress;
return fetcher(transformed, decompress === undefined ? undefined : { decompress });
```

- [ ] **Step 6: Compose the decorator at existing materialization seams**

For API and AI SDK Providers:

```ts
const providerFetch = createProviderRequestTransformFetch(
  provider,
  createObservedFetch(createFetch(effectiveProxy(config.proxy, provider.proxy))),
);
```

For OAuth Providers, keep the shared observed Fetch and decorate it per Provider inside `oauthConfigs.map`:

```ts
runtimeFetch,
runtimeModelFetch: createProviderRequestTransformFetch(provider, runtimeModelFetch),
```

Do not wrap `runtimeFetch`.

- [ ] **Step 7: Add sanitized attempt diagnostics**

`ProviderRequestTransformError` owns only safe fields. `providerRequestTransformDiagnostic()` returns `undefined` for every other error. Spread the result in `logProviderAttemptFailed` and type these optional fields on `RequestProviderAttemptFailedLog`:

```ts
readonly transformRuleIndex?: number;
readonly transformRuleName?: string;
readonly transformStageIndex?: number;
```

Keep `serverErrorDetails()` unchanged; it already reads the error's own `code` and never reads the message, stack, or accessors.

- [ ] **Step 8: Verify GREEN and commit**

Run:

```bash
rtk bun test packages/server/src/provider-request-transform packages/server/src/request-logging/context.test.ts packages/server/src/provider-runtime/materialize.test.ts packages/server/src/provider-runtime/observed-fetch.test.ts packages/server/src/plugin-runtime/host-fetch-context.test.ts packages/server/src/routes/pipeline/raw-fallback.exceptions.test.ts
rtk bun run --filter @aio-proxy/server test:unit
```

Expected: PASS.

```bash
rtk git add packages/server/src/provider-request-transform packages/server/src/request-logging/context.ts packages/server/src/request-logging/context.test.ts packages/server/src/routes/pipeline/attempt packages/server/src/provider-runtime/materialize.ts packages/server/src/provider-runtime/materialize.test.ts packages/server/src/provider-runtime/observed-fetch.test.ts packages/server/src/plugin-runtime/host-fetch-context.test.ts packages/server/src/server-state/snapshot.ts packages/server/src/routes/pipeline/logging.ts packages/server/src/server-log.ts packages/server/src/routes/pipeline/raw-fallback.exceptions.test.ts
rtk git commit -m "feat(server): apply provider request transforms" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Add Dashboard dependencies and canonical Mongo codecs

**Files:**

- Modify: `packages/dashboard/package.json`
- Modify: `bun.lock`
- Create: `packages/dashboard/src/modules/providers/request-transforms/index.ts`
- Create: `packages/dashboard/src/modules/providers/request-transforms/pattern.ts`
- Create: `packages/dashboard/src/modules/providers/request-transforms/pattern.test.ts`
- Create: `packages/dashboard/src/modules/providers/request-transforms/mongo-codec.ts`
- Create: `packages/dashboard/src/modules/providers/request-transforms/mongo-codec.test.ts`
- Create: `packages/dashboard/src/modules/providers/request-transforms/stage-codec.ts`
- Create: `packages/dashboard/src/modules/providers/request-transforms/stage-codec.test.ts`

**Interfaces:**

- Produces `patternToRegex(pattern)` and `regexToPattern(regex)`.
- Produces `parseRequestTransformCondition(when)` and `serializeRequestTransformCondition(query)`.
- Produces `parseRequestTransformStages(stages)` and `serializeRequestTransformStages(drafts)`.
- Produces shared expression metadata/serializers/inverse maps for both condition and Set editors.

- [ ] **Step 1: Add exact UI dependencies**

Run:

```bash
rtk bun add --cwd packages/dashboard react-querybuilder@8.21.2 @react-querybuilder/core@8.21.2 @react-querybuilder/expr@8.21.2
```

Expected: only the Dashboard package and lockfile change; `@react-querybuilder/core` is direct because `parseMongoDB` uses its documented subpath.

- [ ] **Step 2: Write failing Pattern tests**

Use a distinctive canonical wrapper and no `$options` for Pattern:

```ts
expect(patternToRegex('gpt-*-mini')).toBe('^(?:gpt-.*-mini)$');
expect(patternToRegex('a.b+$')).toBe('^(?:a\\.b\\+\\$)$');
expect(regexToPattern('^(?:gpt-.*-mini)$')).toBe('gpt-*-mini');
expect(regexToPattern('^gpt-.*$')).toBeUndefined();
```

Visual Regex always serializes an `$options` key, including `''`; Pattern never does. That keeps Visual Pattern and Visual Regex distinct while preserving the same Mongo semantics.

- [ ] **Step 3: Write failing condition and stage round-trip tests**

Cover:

```ts
expect(roundTripCondition({
  $and: [
    { 'request.model': { $regex: '^(?:gpt-.*)$' } },
    { 'request.body.limit': { $gte: 1 } },
    { $expr: { $eq: [{ $getField: { field: 'x.aio.route', input: '$request.headers' } }, 'blue'] } },
    {
      $expr: {
        $ne: [
          { $ifNull: [{ $getField: { field: 'x-present', input: '$request.headers' } }, null] },
          null,
        ],
      },
    },
    {
      $expr: {
        $regexMatch: {
          input: { $getField: { field: 'x.team', input: '$original.headers' } },
          regex: '^platform-',
          options: 'i',
        },
      },
    },
    { $expr: { $gt: [{ $add: ['$request.body.input', 1] }, '$original.body.limit'] } },
  ],
})).toEqual(theSameAst);
```

Stage tests must round-trip:

- body Set with static strings beginning `$`, arrays, and objects through `$literal`;
- body Set with nested arithmetic/string/conditional/array/object expressions;
- body Remove;
- header Set/Remove with literal dots in names;
- exact stage order and duplicate target writes;
- empty flags on Visual Regex through `$options: ''`.

- [ ] **Step 4: Verify RED**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/request-transforms
```

Expected: FAIL because the codec modules do not exist.

- [ ] **Step 5: Implement expression registries**

Extend the package defaults with only the missing functions:

```ts
export const requestTransformFunctionMeta = {
  ...defaultFunctionMeta,
  concat: { label: 'CONCAT', arity: [2, Infinity] },
  condition: { label: 'IF', arity: 3 },
  ifNull: { label: 'IF NULL', arity: 2 },
  concatArrays: { label: 'CONCAT ARRAYS', arity: [2, Infinity] },
  mergeObjects: { label: 'MERGE OBJECTS', arity: [2, Infinity] },
} satisfies ExpressionFunctionMetaRegistry;

export const requestTransformMongoSerializers = {
  ...defaultMongoDBSerializers,
  concat: '$concat',
  condition: '$cond',
  ifNull: '$ifNull',
  concatArrays: '$concatArrays',
  mergeObjects: '$mergeObjects',
} satisfies MongoAggSerializerRegistry;

export const requestTransformMongoInverse = {
  $concat: 'concat',
  $cond: 'condition',
  $ifNull: 'ifNull',
  $concatArrays: 'concatArrays',
  $mergeObjects: 'mergeObjects',
};
```

Add a private `__literal` serializer that returns `{ $literal: value }` and a parser-only inverse/meta entry for `$literal`. Before `serializeMongoAgg()`, replace any expression `value` node containing an array, object, or string beginning with `$` by a private `__literal` function node; after parsing, unwrap that private node back to the original `value` node. Do not include `__literal` in `requestTransformFunctionMeta`, so it never appears in the visual function selector.

Use `getExpressionParserMongoDB(parserInverse, parserMeta)` for imports and `getExpressionRuleProcessorMongoDBQuery(requestTransformMongoSerializers)` plus `serializeMongoAgg()` for exports.

- [ ] **Step 6: Implement canonical condition conversion**

Import `parseMongoDB` from `@react-querybuilder/core/parseMongoDB`. Before parsing, rewrite generated header `$expr` forms to internal sentinel fields:

```ts
const headerField = (scope: 'request' | 'original', name: string) =>
  `__aio_header__:${scope}:${encodeURIComponent(name)}`;
```

Before expression parsing, rewrite every generated `$getField` leaf to the same internal sentinel field reference. After `parseMongoDB`, map regular body fields to `request.body:<path>` / `original.body:<path>` and sentinels to `request.header:<name>` / `original.header:<name>`. On serialization, map UI field IDs to temporary sentinel field nodes, use the package Mongo serializer, then replace sentinel field-reference strings with exact `$getField` objects. Regenerate `$regexMatch` and Exists/Does not exist `$ifNull` objects for Header conditions.

Pattern recognition is allowed only when `$options` is absent and `regexToPattern()` accepts the distinctive canonical wrapper. Any other `$regex` is Visual Regex. Visual Regex always writes `$options`, normalized in `imsu` order, so a general regex entered or edited in Regex mode does not become Pattern after a mode switch.

Call `ProviderRequestTransformRulesSchema.parse([{ when, update: [{ $unset: 'request.body.__codec_probe__' }] }])` on codec output in tests so the Dashboard codec cannot drift outside the server profile.

- [ ] **Step 7: Implement canonical stage conversion**

Use this visual draft union:

```ts
export type RequestTransformStageDraft =
  | {
      readonly kind: 'set';
      readonly target: 'body' | 'header';
      readonly path: string;
      readonly value:
        | { readonly kind: 'static'; readonly value: JsonValue }
        | { readonly kind: 'expression'; readonly expression: ExpressionNode };
    }
  | {
      readonly kind: 'remove';
      readonly target: 'body' | 'header';
      readonly path: string;
    };
```

Whole-stage Static serialization uses `$literal` when the value is an array, object, or a string beginning with `$`:

```ts
const staticExpression = (value: JsonValue): JsonValue =>
  Array.isArray(value) || (typeof value === 'object' && value !== null) ||
  (typeof value === 'string' && value.startsWith('$'))
    ? { $literal: value }
    : value;
```

Header drafts emit the exact generated forms from Task 1. Reject non-canonical input rather than splitting multi-target stages or normalizing nested header operations.

- [ ] **Step 8: Verify GREEN and commit**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/request-transforms
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: PASS.

```bash
rtk git add packages/dashboard/package.json bun.lock packages/dashboard/src/modules/providers/request-transforms
rtk git commit -m "feat(dashboard): add request transform codecs" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Add JSON-mode editing to every Provider form

**Files:**

- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/index.ts`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/provider-request-transforms-editor.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/provider-request-transforms-json-editor.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/provider-request-transforms-editor.test.tsx`
- Modify: `packages/dashboard/src/components/json-editor/json-editor.tsx`
- Modify: `packages/dashboard/src/modules/providers/hooks/use-provider-form.ts`
- Modify: `packages/dashboard/src/modules/providers/hooks/use-oauth-provider-edit-form.ts`
- Modify: `packages/dashboard/src/modules/providers/components/provider-form-fields-api.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-form-fields-ai-sdk.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/oauth-provider-edit-fields.tsx`
- Modify: `packages/dashboard/src/modules/providers/templates/provider-form-page.tsx`
- Modify: `packages/dashboard/src/modules/providers/templates/use-oauth-provider-edit-page.ts`
- Modify: `packages/dashboard/src/modules/providers/templates/oauth-provider-edit-page.tsx`
- Modify: `packages/dashboard/src/modules/providers/services/oauth-provider-edit.ts`
- Modify: `packages/dashboard/src/modules/providers/services/oauth-provider-edit.test.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**

- Produces `ProviderRequestTransformsEditor` with canonical rules, `onChange`, and `onValidityChange` props.
- Adds `transforms` to both normal and OAuth TanStack Form values.
- Invalid JSON or semantic AST prevents saving without replacing the last valid form value.

- [ ] **Step 1: Write failing JSON editor and OAuth submission tests**

Render the editor with one rule and assert:

```ts
expect(screen.getByRole('textbox', { name: /request transforms json/i })).toHaveValue(
  expect.stringContaining('"$unset": "request.body.store"'),
);
```

Enter malformed JSON and then a structurally valid but unsupported `$project` stage. In both cases assert `onValidityChange(false)` and no `onChange` call. Enter a valid `$set` stage and assert the parsed canonical rule array is emitted.

Extend `oauth-provider-edit.test.ts`:

```ts
const transforms = { request: [{ update: [{ $unset: 'request.body.store' }] }] };
expect(
  oauthProviderEditAction(
    { ...values, transforms },
    initialPublicValues,
  ),
).toEqual({
  kind: 'update',
  body: expect.objectContaining({ transforms }),
});
```

Also assert reauthorization places the same transforms under `input.providerPatch`.

- [ ] **Step 2: Verify RED**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/components/provider-request-transforms/provider-request-transforms-editor.test.tsx src/modules/providers/services/oauth-provider-edit.test.ts
```

Expected: FAIL because the editor and form fields do not exist.

- [ ] **Step 3: Build the JSON editor around the existing Monaco component**

The public component edits a rule array, not the outer `{ request }` wrapper:

```ts
interface ProviderRequestTransformsEditorProps {
  readonly value: readonly ProviderRequestTransformRule[];
  readonly onChange: (value: readonly ProviderRequestTransformRule[]) => void;
  readonly onValidityChange: (valid: boolean) => void;
}
```

`ProviderRequestTransformsJsonEditor` passes `ProviderRequestTransformRulesJsonSchema` to the existing `JsonEditor`. On every parsed value, run `ProviderRequestTransformRulesSchema.safeParse(value)`. Emit only `result.data`. Combine Monaco syntax/schema validity with semantic validity for `onValidityChange` and render the first semantic issue as an i18n message containing its JSON path and stable issue code.

Add an optional `ariaLabel` prop to the shared `JsonEditor` and pass it to Monaco through `CodeEditor`'s `options={{ ariaLabel }}`. The request-transform wrapper supplies the localized JSON label, which makes the test's named textbox query and the production editor accessible.

Insert these messages under `dashboard.providers.transforms`:

```json
{
  "section": "Request transforms",
  "description": "Modify the outbound request for this Provider before it is sent upstream.",
  "json_label": "Request transforms JSON",
  "invalid": "Invalid transform at {path}: {code}",
  "empty": "No request transforms configured."
}
```

Chinese values:

```json
{
  "section": "请求修改",
  "description": "在请求发送到上游之前，按当前 Provider 的配置修改出站请求。",
  "json_label": "请求修改 JSON",
  "invalid": "修改配置无效（{path}）：{code}",
  "empty": "尚未配置请求修改。"
}
```

- [ ] **Step 4: Bind the shared value through TanStack Form**

For API and AI SDK forms, render one shared section:

```tsx
<form.Field name="transforms">
  {(field) => (
    <ProviderRequestTransformsEditor
      value={field.state.value?.request ?? []}
      onChange={(request) => field.handleChange({ request })}
      onValidityChange={onTransformsValidityChange}
    />
  )}
</form.Field>
```

Add `transforms?: ProviderTransforms` to `OAuthProviderCommonFormValues`, include it in `OAuthProviderMutationBodySchema.safeParse`, seed it from `provider.transforms`, and include it in `OAuthProviderEditValues`/`providerPatch`.

Track editor validity in the page-level owner:

- `ProviderFormPage`: `optionsValid && transformsValid` gates submit and Save.
- `useOAuthProviderEditPage`: return `transformsValid` and `setTransformsValid`; `submit()` returns before alias checks when invalid.
- `OAuthProviderEditPage`: disable Save/Reauthorize when transforms are invalid.

Rename touched generic `Props` declarations to the required `<ComponentName>Props` interfaces while editing those files; do not refactor unrelated components.

- [ ] **Step 5: Compile i18n, verify, and commit**

Run:

```bash
rtk bun run i18n:compile
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/components/provider-request-transforms/provider-request-transforms-editor.test.tsx src/modules/providers/services/oauth-provider-edit.test.ts src/modules/providers/templates/oauth-provider-edit-page.test.tsx
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: PASS.

```bash
rtk git add packages/dashboard/src/components/json-editor/json-editor.tsx packages/dashboard/src/modules/providers/components/provider-request-transforms packages/dashboard/src/modules/providers/hooks/use-provider-form.ts packages/dashboard/src/modules/providers/hooks/use-oauth-provider-edit-form.ts packages/dashboard/src/modules/providers/components/provider-form-fields-api.tsx packages/dashboard/src/modules/providers/components/provider-form-fields-ai-sdk.tsx packages/dashboard/src/modules/providers/components/oauth-provider-edit-fields.tsx packages/dashboard/src/modules/providers/templates/provider-form-page.tsx packages/dashboard/src/modules/providers/templates/use-oauth-provider-edit-page.ts packages/dashboard/src/modules/providers/templates/oauth-provider-edit-page.tsx packages/dashboard/src/modules/providers/services/oauth-provider-edit.ts packages/dashboard/src/modules/providers/services/oauth-provider-edit.test.ts packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json packages/i18n/src
rtk git commit -m "feat(dashboard): edit request transforms as json" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Build the visual condition editor

**Files:**

- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/query-builder/index.ts`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/query-builder/query-builder-shadcn.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/query-builder/query-builder-action-element.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/query-builder/query-builder-not-toggle.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/query-builder/query-builder-shift-actions.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/query-builder/query-builder-value-editor.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/query-builder/query-builder-value-selector.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/request-transform-field-selector.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/request-transform-condition-editor.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/request-transform-condition-editor.test.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**

- Produces adapted `QueryBuilderShadcn` controls.
- Produces `RequestTransformConditionEditor` that reads/writes one canonical `when` document.
- Supports fixed metadata fields plus arbitrary body paths and header names for current/original request scopes.

- [ ] **Step 1: Write failing condition-editor tests**

Render a nested condition containing model Pattern, current Header equality, original Header Regex, and `$expr` arithmetic. Assert the visible controls expose the decoded values. Change each control and assert the emitted AST uses:

- escaped Pattern `$regex` without `$options`;
- raw Regex `$regex` with `$options` even when flags are empty;
- `$getField` for Header equality;
- `$regexMatch` for Header Pattern/Regex;
- `$expr` with the configured Mongo expression serializer.

Add an interaction that selects `Current body field`, enters `max_output_tokens`, chooses `Greater than`, and enters `8192`; assert:

```ts
{ 'request.body.max_output_tokens': { $gt: 8192 } }
```

- [ ] **Step 2: Verify RED**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/components/provider-request-transforms/request-transform-condition-editor.test.tsx
```

Expected: FAIL because the visual controls do not exist.

- [ ] **Step 3: Adapt the pinned official shadcn registry controls**

Use the six files under:

```text
https://github.com/react-querybuilder/react-querybuilder/tree/389b271cadc54080d4ad096d5b3ab57db5d688c4/website/registry/default/query-builder
```

Apply only these repository-required adaptations:

- kebab-case filenames and export-only `index.ts`;
- one React component per `.tsx` file;
- `React.FC<ComponentNameProps>` plus named prop interfaces;
- existing Base UI-backed `Button`, `Input`, `Select`, `Switch`, `Label`, `Textarea`, and `Checkbox` imports;
- remove the unused Radio branch instead of adding `radio-group`;
- filter the `parameter` expression-kind option in `QueryBuilderValueSelector`, because named parameters are outside the shared AST; for the Set editor's root `testID`, additionally filter out `value` so Computed means Field or Function while Static owns literal values;
- replace package-provided visible labels/titles in the adapted selectors with i18n messages based on `testID`.

Keep one provenance comment with the pinned commit and MIT license; do not copy registry demo code or styles unrelated to the controls.

- [ ] **Step 4: Implement dynamic field selection**

Represent UI-only fields with these prefixes:

```ts
type TransformFieldKind =
  | 'provider.id'
  | 'provider.kind'
  | 'provider.protocol'
  | 'request.model'
  | 'request.requestedModel'
  | 'request.sourceProtocol'
  | 'request.targetProtocol'
  | 'request.method'
  | 'request.url'
  | 'request.body:'
  | 'original.body:'
  | 'request.header:'
  | 'original.header:';
```

`RequestTransformFieldSelector` renders one Select for the kind and one Input for the suffix when the selected kind ends in `:`. Lowercase header suffixes on change. Body suffixes retain Mongo dot-path spelling and rely on shared validation for unsafe segments.

The adapted `QueryBuilderValueSelector` applies the same Select + suffix Input behavior when `ExpressionEditor` requests a field selector (`testID` ending in `-field`). This lets nested condition and Set expressions reference arbitrary current/original body paths and Header names instead of limiting them to fixed metadata fields.

- [ ] **Step 5: Assemble React Query Builder with the canonical codecs**

Wrap the builder in both providers:

```tsx
<QueryBuilderShadcn>
  <QueryBuilderExpressions
    functions={requestTransformFunctionMeta}
    translations={expressionTranslations}
  >
    <QueryBuilder
      fields={requestTransformFields}
      operators={requestTransformOperators}
      query={parseRequestTransformCondition(value)}
      onQueryChange={(query) => onChange(serializeRequestTransformCondition(query))}
      controlElements={{ fieldSelector: RequestTransformFieldSelector }}
      showNotToggle
      showShiftActions
      listsAsArrays
    />
  </QueryBuilderExpressions>
</QueryBuilderShadcn>
```

Import `react-querybuilder/dist/query-builder.css` once from this component and use Tailwind only for local spacing/layout.

Expose these operator labels through i18n: Equals, Not equal, Greater than, Greater than or equal, Less than, Less than or equal, In, Not in, Exists, Does not exist, Matches pattern, Regex. Use `getOperators(field)` to limit Header fields to Equals, Not equal, Exists, Does not exist, Matches pattern, and Regex; the other fields use the full profile. Add expression-kind and action labels required by the adapted registry controls.

- [ ] **Step 6: Compile i18n, verify GREEN, and commit**

Run:

```bash
rtk bun run i18n:compile
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/components/provider-request-transforms/request-transform-condition-editor.test.tsx src/modules/providers/request-transforms
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: PASS.

```bash
rtk git add packages/dashboard/src/modules/providers/components/provider-request-transforms/query-builder packages/dashboard/src/modules/providers/components/provider-request-transforms/request-transform-field-selector.tsx packages/dashboard/src/modules/providers/components/provider-request-transforms/request-transform-condition-editor.tsx packages/dashboard/src/modules/providers/components/provider-request-transforms/request-transform-condition-editor.test.tsx packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json packages/i18n/src
rtk git commit -m "feat(dashboard): edit transform conditions visually" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Build ordered visual Set/Remove actions and complete mode switching

**Files:**

- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/provider-request-transforms-visual-editor.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/request-transform-rule-card.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/request-transform-stage-list.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/request-transform-stage-card.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/request-transform-static-value-editor.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/request-transform-expression-editor.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-request-transforms/provider-request-transforms-visual-editor.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-request-transforms/provider-request-transforms-editor.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-request-transforms/provider-request-transforms-editor.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-request-transforms/index.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**

- Completes Visual/JSON tabs over the same canonical rule array.
- Every visual card maps one-to-one to one persisted rule or one single-target stage.
- Static Set values and computed Set expressions remain distinct.

- [ ] **Step 1: Write failing visual action tests**

Use one rule with four stages: Set body static, Set header computed, Remove body, Remove header. Assert initial controls decode all values, then exercise:

- add rule;
- remove rule;
- move rule up/down;
- add Set and Remove stages;
- switch target between Header and Body;
- move duplicate writes without merging them;
- switch Set value between Static and Computed;
- enter a static string beginning `$` and assert `$literal`;
- enter a nested expression and assert the exact Mongo AST;
- switch Visual → JSON → Visual and assert byte-equivalent canonical AST.

Add a regression where JSON mode contains unsupported syntax: the Visual tab and Save validity remain disabled until JSON is valid again.

- [ ] **Step 2: Verify RED**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/components/provider-request-transforms/provider-request-transforms-visual-editor.test.tsx src/modules/providers/components/provider-request-transforms/provider-request-transforms-editor.test.tsx
```

Expected: FAIL because visual rules/stages are not implemented.

- [ ] **Step 3: Implement the ordered visual rule list**

Keep the persisted value canonical and controlled. Local UI state owns only the active tab and expansion state. Rules use accessible index-based labels; all editors are controlled, so no persistent draft IDs are required.

Each rule card contains:

- optional name Input;
- `RequestTransformConditionEditor` with omission representing match-all;
- `RequestTransformStageList`;
- Remove, Move Up, and Move Down buttons.

Adding a rule emits this valid minimum:

```ts
{ update: [{ $unset: 'request.body.value' }] }
```

Immediately focus the new body path input so the user can replace the harmless default target without another click.

- [ ] **Step 4: Implement Set/Remove stage cards**

Use Select controls for action (`set`/`remove`), target (`header`/`body`), and Set value mode (`static`/`expression`). Header paths use a lowercase Input; body paths use a dot-path Input.

`RequestTransformStaticValueEditor` reuses the existing `JsonEditor` at 120px height with no schema and validates one JSON value. `RequestTransformExpressionEditor` reuses package `ExpressionEditor` under the adapted `QueryBuilderShadcn` and `QueryBuilderExpressions` providers:

```tsx
<ExpressionEditor
  node={expression}
  onChange={onChange}
  meta={requestTransformFunctionMeta}
  schema={schema}
  testID="transform-set-expression"
/>
```

Seed computed mode with `{ kind: 'field', field: 'request.body.value' }`. Seed static mode with `null`.

Move Up/Down operates on the exact array index and never combines adjacent `$set` stages, even when their targets differ.

- [ ] **Step 5: Complete lossless tab behavior and copy**

`ProviderRequestTransformsEditor` owns:

```ts
const [mode, setMode] = useState<'visual' | 'json'>('visual');
const [jsonValid, setJsonValid] = useState(true);
```

Both tabs read `value`; every valid change immediately emits canonical rules. Disable Visual while JSON is invalid so an invalid Monaco draft is never silently discarded. An empty rule array renders the empty state and still remains valid.

Add English/Chinese messages for rule/action add/remove/move, name, condition, match-all, target, Header, Body, path/name, Static, Computed, and the Visual/JSON tab labels.

- [ ] **Step 6: Compile i18n, verify GREEN, and commit**

Run:

```bash
rtk bun run i18n:compile
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/components/provider-request-transforms src/modules/providers/request-transforms
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: PASS.

```bash
rtk git add packages/dashboard/src/modules/providers/components/provider-request-transforms packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json packages/i18n/src
rtk git commit -m "feat(dashboard): edit request transforms visually" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Run the cross-package acceptance matrix

**Files:**

- None; this task is a read-only release gate. A failure leaves the owning implementation task incomplete.

**Interfaces:**

- Verifies the public Provider config, server dispatch, fallback, observed logging, and Dashboard round trips together.

- [ ] **Step 1: Run focused behavior suites**

Run:

```bash
rtk bun test packages/types/src/provider-transform packages/server/src/dashboard-routes/provider-mutation/provider-mutation.test.ts packages/server/src/provider-request-transform packages/server/src/provider-runtime/materialize.test.ts packages/server/src/provider-runtime/observed-fetch.test.ts packages/server/src/plugin-runtime/host-fetch-context.test.ts packages/server/src/routes/pipeline/raw-fallback.exceptions.test.ts
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/providers/request-transforms src/modules/providers/components/provider-request-transforms src/modules/providers/services/oauth-provider-edit.test.ts src/modules/providers/templates/oauth-provider-edit-page.test.tsx
```

Expected: PASS with explicit coverage for sequential matching, original/current isolation, Header/body Set/Remove, literal `$` values, regex flags, lazy body reads, all Provider kinds, OAuth auxiliary bypass, transformed wire logs, and fallback.

- [ ] **Step 2: Run package builds and static checks**

Run:

```bash
rtk bun run --filter @aio-proxy/types build
rtk bun run --filter @aio-proxy/server test:unit
rtk bun run --filter @aio-proxy/dashboard build
rtk bun run lint:types
rtk bun x oxfmt --check package.json packages/types/package.json packages/types/src/provider-transform packages/types/src/provider.ts packages/types/src/dashboard-oauth.ts packages/types/src/index.ts packages/server/package.json packages/server/src/dashboard-routes/provider-mutation packages/server/src/provider-request-transform packages/server/src/request-logging/context.ts packages/server/src/routes/pipeline/attempt packages/server/src/provider-runtime/materialize.ts packages/server/src/server-state/snapshot.ts packages/server/src/routes/pipeline/logging.ts packages/server/src/server-log.ts packages/dashboard/package.json packages/dashboard/src/components/json-editor/json-editor.tsx packages/dashboard/src/modules/providers/request-transforms packages/dashboard/src/modules/providers/components/provider-request-transforms packages/dashboard/src/modules/providers/hooks packages/dashboard/src/modules/providers/services/oauth-provider-edit.ts packages/dashboard/src/modules/providers/templates packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json
```

Expected: PASS. Existing unrelated lint warnings may remain; no new warning may point to a changed file.

- [ ] **Step 3: Run full preflight and record the known baseline honestly**

Run:

```bash
rtk bun run preflight
```

Expected on current `main` (`97746df`): the only failure is the unchanged pre-existing `CHANGELOG.md` formatting check. If that baseline failure has been repaired before execution, expect PASS. In either case, Step 2 must already prove every changed file passes formatting.

- [ ] **Step 4: Review the final diff against the non-goals**

Run:

```bash
rtk git diff --check main...HEAD
rtk git diff --stat main...HEAD
rtk git status --short
```

Confirm the diff contains no response transform, dry-run UI, DnD package, Mingo Dashboard bundle, FFI/native artifact, arbitrary script operator, or unrelated refactor.
