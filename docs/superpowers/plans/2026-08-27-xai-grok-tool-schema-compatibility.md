# xAI Grok Tool Schema Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve valid Codex function-tool contracts on xAI Grok OAuth requests by resolving local schema references, producing explicit object-root union branches, and quarantining only schemas that cannot be converted safely.

**Architecture:** Extend the existing xAI-only Responses body sanitizer rather than changing Codex or shared protocol adapters. The sanitizer normalizes every function catalog before the existing custom-tool compiler runs, records retained/quarantined names across top-level, namespace, and `additional_tools` surfaces, then repairs structured `tool_choice` references. Unsafe schemas fail closed at the individual-tool boundary.

**Tech Stack:** Bun 1.4, TypeScript 7, OpenAI Responses JSON, `bun:test`, Changesets.

**Spec:** `docs/superpowers/specs/2026-08-27-xai-grok-tool-schema-compatibility-design.md`

## Global Constraints

- Keep the compatibility behavior inside `packages/plugins/xai-grok`; do not modify Codex tools or shared protocol adapters.
- Apply schema normalization to every xAI-bound function tool; do not match `automation_update`, `codex_app`, or `mcp__` by name.
- Preserve the tool's original `strict` value and every safely representable schema constraint.
- Never replace a schema with an open empty object.
- Quarantine only the incompatible tool and keep unrelated function, custom, namespace, and hosted tools.
- Cover top-level `tools`, namespace children, and `input[].type === "additional_tools"`.
- Keep structured `tool_choice` consistent with quarantined tools.
- Add no dependency, public SDK type, configuration, database, routing, or dashboard change.
- Add a patch changeset for `@aio-proxy/plugin-xai-grok` and `aio-proxy`.
- Run every command in this plan through `rtk`.

---

## File Structure

| File | Responsibility after this change |
| --- | --- |
| `packages/plugins/xai-grok/src/runtime/sanitize-responses/sanitize-responses.ts` | Removes unsupported top-level fields, resolves local tool-schema references, expands root object unions, quarantines unsafe tools, and repairs structured tool choice. |
| `packages/plugins/xai-grok/src/runtime/sanitize-responses/sanitize-responses.test.ts` | Protects the trace-derived six-branch schema, ordinary tools, quarantine behavior, namespaces, `additional_tools`, and tool-choice synchronization. |
| `packages/plugins/xai-grok/src/runtime/runtime.test.ts` | Proves the normalized schema reaches the actual xAI dynamic-fetch boundary before dispatch. |
| `.changeset/xai-grok-tool-schema-compatibility.md` | Publishes the user-visible xAI/Codex tool compatibility fix. |

### Task 1: Replace the name workaround with lossless root-union normalization

**Files:**
- Modify: `packages/plugins/xai-grok/src/runtime/sanitize-responses/sanitize-responses.ts:1-51`
- Modify: `packages/plugins/xai-grok/src/runtime/sanitize-responses/sanitize-responses.test.ts:1-90`

**Interfaces:**
- Consumes: raw UTF-8 OpenAI Responses request bytes and function tools whose `parameters` are JSON Schema values.
- Produces: the existing public `sanitizeXAIGrokResponsesBody(bytes: Uint8Array): Uint8Array` API.
- Produces internally: `normalizeXAIToolParameters(value: unknown): Record<string, unknown> | undefined`; `undefined` means quarantine this function tool.

- [ ] **Step 1: Replace the automation-name test with the trace-derived failing regression**

In `sanitize-responses.test.ts`, remove `simplifies Codex automation_update schemas` and `leaves a top-level automation_update tool unchanged`. Add the captured schema as a local constant and assert that the tool contract survives as six explicit object branches:

```ts
const capturedAutomationUpdateParameters = JSON.parse(`{"type":"object","properties":{},"oneOf":[{"$ref":"#/$defs/__schema0"},{"$ref":"#/$defs/__schema3"},{"$ref":"#/$defs/__schema21"},{"$ref":"#/$defs/__schema24"}],"$defs":{"__schema0":{"type":"object","properties":{"id":{"$ref":"#/$defs/__schema1"},"mode":{"type":"string","enum":["view"]}},"required":["mode","id"],"additionalProperties":false},"__schema1":{"$ref":"#/$defs/__schema2"},"__schema10":{"anyOf":[{"type":"string","enum":["failed_runs_only"]},{"type":"null"}]},"__schema11":{"type":"string","enum":["cron"]},"__schema12":{"anyOf":[{"$ref":"#/$defs/__schema13"},{"type":"null"}]},"__schema13":{"type":"string"},"__schema14":{"$ref":"#/$defs/__schema2"},"__schema15":{"type":"string","enum":["none","minimal","low","medium","high","xhigh","max","ultra"]},"__schema16":{"type":"string","enum":["create","suggested_create"]},"__schema17":{"type":"object","properties":{"destination":{"$ref":"#/$defs/__schema19"},"kind":{"$ref":"#/$defs/__schema18"},"mode":{"$ref":"#/$defs/__schema16"},"name":{"$ref":"#/$defs/__schema5"},"notificationPolicy":{"$ref":"#/$defs/__schema9"},"prompt":{"$ref":"#/$defs/__schema6"},"rrule":{"$ref":"#/$defs/__schema7"},"status":{"$ref":"#/$defs/__schema8"},"targetThreadId":{"$ref":"#/$defs/__schema20"}},"required":["name","prompt","rrule","status","kind","mode"],"additionalProperties":false},"__schema18":{"type":"string","enum":["heartbeat"]},"__schema19":{"type":"string","enum":["local","thread"]},"__schema2":{"type":"string"},"__schema20":{"$ref":"#/$defs/__schema2","type":"string"},"__schema21":{"oneOf":[{"type":"object","properties":{"destination":{"type":"string","enum":["local","worktree"]},"executionEnvironment":{"type":"string","enum":["worktree","local"]},"id":{"$ref":"#/$defs/__schema1"},"kind":{"$ref":"#/$defs/__schema11"},"localEnvironmentConfigPath":{"anyOf":[{"type":"string"},{"type":"null"}]},"mode":{"$ref":"#/$defs/__schema23"},"model":{"$ref":"#/$defs/__schema14"},"name":{"$ref":"#/$defs/__schema5"},"notificationPolicy":{"$ref":"#/$defs/__schema9"},"projectId":{"$ref":"#/$defs/__schema12"},"prompt":{"$ref":"#/$defs/__schema6"},"reasoningEffort":{"$ref":"#/$defs/__schema15"},"rrule":{"$ref":"#/$defs/__schema22"},"status":{"$ref":"#/$defs/__schema8"}},"required":["name","prompt","rrule","status","kind","projectId","model","reasoningEffort","mode","id","executionEnvironment"],"additionalProperties":false},{"type":"object","properties":{"destination":{"$ref":"#/$defs/__schema19"},"id":{"$ref":"#/$defs/__schema1"},"kind":{"$ref":"#/$defs/__schema18"},"mode":{"$ref":"#/$defs/__schema23"},"name":{"$ref":"#/$defs/__schema5"},"notificationPolicy":{"$ref":"#/$defs/__schema9"},"prompt":{"$ref":"#/$defs/__schema6"},"rrule":{"$ref":"#/$defs/__schema22"},"status":{"$ref":"#/$defs/__schema8"},"targetThreadId":{"$ref":"#/$defs/__schema20"}},"required":["name","prompt","rrule","status","kind","mode","id"],"additionalProperties":false}]},"__schema22":{"$ref":"#/$defs/__schema2"},"__schema23":{"type":"string","enum":["update","suggested_update"]},"__schema24":{"type":"object","properties":{"id":{"$ref":"#/$defs/__schema1"},"mode":{"type":"string","enum":["delete"]}},"required":["mode","id"],"additionalProperties":false},"__schema3":{"oneOf":[{"$ref":"#/$defs/__schema4"},{"$ref":"#/$defs/__schema17"}]},"__schema4":{"type":"object","properties":{"destination":{"type":"string","enum":["local"]},"executionEnvironment":{"type":"string","enum":["local"]},"kind":{"$ref":"#/$defs/__schema11"},"mode":{"$ref":"#/$defs/__schema16"},"model":{"$ref":"#/$defs/__schema14"},"name":{"$ref":"#/$defs/__schema5"},"notificationPolicy":{"$ref":"#/$defs/__schema9"},"projectId":{"$ref":"#/$defs/__schema12"},"prompt":{"$ref":"#/$defs/__schema6"},"reasoningEffort":{"$ref":"#/$defs/__schema15"},"rrule":{"$ref":"#/$defs/__schema7"},"status":{"$ref":"#/$defs/__schema8"}},"required":["name","prompt","rrule","status","kind","projectId","model","reasoningEffort","mode","executionEnvironment"],"additionalProperties":false},"__schema5":{"$ref":"#/$defs/__schema2"},"__schema6":{"$ref":"#/$defs/__schema2"},"__schema7":{"$ref":"#/$defs/__schema2"},"__schema8":{"type":"string","enum":["ACTIVE","PAUSED"]},"__schema9":{"$ref":"#/$defs/__schema10"}}}`) as Record<string, unknown>;

test('keeps the captured Codex automation tool as six explicit object branches', () => {
  const ordinary = {
    type: 'function',
    name: 'exec_command',
    strict: true,
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
  };
  const cleaned = decode(
    sanitizeXAIGrokResponsesBody(
      encode({
        tools: [
          {
            type: 'function',
            name: 'mcp__codex_app__automation_update',
            strict: false,
            parameters: capturedAutomationUpdateParameters,
          },
          ordinary,
        ],
      }),
    ),
  );

  const parameters = cleaned.tools[0].parameters as Record<string, unknown>;
  const branches = parameters.oneOf as Array<Record<string, unknown>>;
  expect(cleaned.tools[0].strict).toBe(false);
  expect(branches).toHaveLength(6);
  expect(branches.every((branch) => branch.type === 'object')).toBe(true);
  expect(JSON.stringify(parameters)).not.toContain('$ref');
  expect(parameters).not.toHaveProperty('$defs');
  expect(branches.map((branch) => (branch.properties as Record<string, unknown>).mode)).toEqual([
    { type: 'string', enum: ['view'] },
    { type: 'string', enum: ['create', 'suggested_create'] },
    { type: 'string', enum: ['create', 'suggested_create'] },
    { type: 'string', enum: ['update', 'suggested_update'] },
    { type: 'string', enum: ['update', 'suggested_update'] },
    { type: 'string', enum: ['delete'] },
  ]);
  expect(cleaned.tools[1]).toEqual(ordinary);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src/runtime/sanitize-responses/sanitize-responses.test.ts
```

Expected: FAIL because the current name workaround misses `mcp__codex_app__automation_update`, leaving four `$ref` branches rather than six explicit object branches.

- [ ] **Step 3: Implement local-reference resolution and root-union expansion**

In `sanitize-responses.ts`, delete `SAFE_PARAMETERS`, `isAutomationUpdate()`, and the automation-specific branch. Add these private contracts and helpers in the same file; do not create a generic schema package:

```ts
type JsonObject = Record<string, unknown>;
type UnionKey = 'anyOf' | 'oneOf';

function normalizeXAIToolParameters(value: unknown): JsonObject | undefined {
  const root = asRecord(value);
  if (root === undefined) return undefined;
  const resolved = resolveLocalRefs(root, root, new Set());
  if (resolved === undefined || Array.isArray(resolved) || asRecord(resolved) === undefined) return undefined;
  const schema = { ...(resolved as JsonObject) };
  Reflect.deleteProperty(schema, '$defs');
  Reflect.deleteProperty(schema, 'definitions');
  Reflect.deleteProperty(schema, '$schema');
  return expandRootObjectUnion(schema);
}

function resolveLocalRefs(value: unknown, root: JsonObject, stack: Set<string>): unknown | undefined {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const resolved = resolveLocalRefs(item, root, stack);
      if (resolved === undefined) return undefined;
      result.push(resolved);
    }
    return result;
  }
  const record = asRecord(value);
  if (record === undefined) return value;

  if (Object.hasOwn(record, '$ref')) {
    const ref = record['$ref'];
    if (typeof ref !== 'string' || !ref.startsWith('#/') || stack.has(ref)) return undefined;
    const target = lookupLocalPointer(root, ref);
    if (target === undefined) return undefined;
    stack.add(ref);
    const resolvedTarget = resolveLocalRefs(target, root, stack);
    stack.delete(ref);
    if (resolvedTarget === undefined) return undefined;

    const siblings = Object.fromEntries(Object.entries(record).filter(([key]) => key !== '$ref'));
    if (Object.keys(siblings).length === 0) return resolvedTarget;
    const resolvedSiblings = resolveLocalRefs(siblings, root, stack);
    if (resolvedSiblings === undefined) return undefined;
    const targetRecord = asRecord(resolvedTarget);
    const siblingRecord = asRecord(resolvedSiblings);
    if (targetRecord === undefined || siblingRecord === undefined) return undefined;
    const targetType = targetRecord['type'];
    const siblingType = siblingRecord['type'];
    if (targetType !== undefined && siblingType !== undefined && targetType !== siblingType) return undefined;
    const type = targetType ?? siblingType;
    return { ...(type === undefined ? {} : { type }), allOf: [targetRecord, siblingRecord] };
  }

  const resolved: JsonObject = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === '$defs' || key === 'definitions') continue;
    const next = resolveLocalRefs(child, root, stack);
    if (next === undefined) return undefined;
    resolved[key] = next;
  }
  return resolved;
}

function lookupLocalPointer(root: JsonObject, ref: string): unknown {
  let current: unknown = root;
  for (const rawToken of ref.slice(2).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    const record = asRecord(current);
    if (record === undefined || !Object.hasOwn(record, token)) return undefined;
    current = record[token];
  }
  return current;
}

function expandRootObjectUnion(schema: JsonObject): JsonObject | undefined {
  const oneOf = Array.isArray(schema['oneOf']);
  const anyOf = Array.isArray(schema['anyOf']);
  if (oneOf && anyOf) return undefined;
  const key: UnionKey | undefined = oneOf ? 'oneOf' : anyOf ? 'anyOf' : undefined;
  if (key === undefined) return objectBranch(schema);

  const branches = expandObjectBranches(schema[key], key);
  if (branches === undefined) return undefined;
  return { ...schema, type: 'object', [key]: branches };
}

function expandObjectBranches(value: unknown, key: UnionKey): JsonObject[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const expanded: JsonObject[] = [];
  for (const item of value) {
    const branch = asRecord(item);
    if (branch === undefined) return undefined;
    if (Array.isArray(branch[key])) {
      const siblings = Object.fromEntries(Object.entries(branch).filter(([name]) => name !== key));
      const nested = expandObjectBranches(branch[key], key);
      if (nested === undefined) return undefined;
      if (Object.keys(siblings).length === 0) {
        expanded.push(...nested);
        continue;
      }
      const siblingObject = objectBranch(siblings);
      if (siblingObject === undefined) return undefined;
      expanded.push(...nested.map((child) => ({ type: 'object', allOf: [siblingObject, child] })));
      continue;
    }
    const object = objectBranch(branch);
    if (object === undefined) return undefined;
    expanded.push(object);
  }
  return expanded;
}

function objectBranch(schema: JsonObject): JsonObject | undefined {
  const type = schema['type'];
  if (type !== undefined && type !== 'object') return undefined;
  return type === 'object' ? schema : { ...schema, type: 'object' };
}
```

Change `sanitizeTools()` so every function with a `parameters` field calls `normalizeXAIToolParameters()`. For this task, keep the tool in place when normalization succeeds and leave quarantine wiring for Task 2.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src/runtime/sanitize-responses/sanitize-responses.test.ts
```

Expected: PASS. The captured schema has six explicit object branches, no `$ref` or `$defs`, retains its mode enums and closed-object constraints, and the ordinary tool is byte-for-byte equivalent after JSON parsing.

- [ ] **Step 5: Commit the normalization behavior**

```bash
rtk git add packages/plugins/xai-grok/src/runtime/sanitize-responses
rtk git commit -m "fix(xai-grok): normalize Responses tool schemas" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Quarantine unsafe tools and repair structured tool choice

**Files:**
- Modify: `packages/plugins/xai-grok/src/runtime/sanitize-responses/sanitize-responses.ts`
- Modify: `packages/plugins/xai-grok/src/runtime/sanitize-responses/sanitize-responses.test.ts`

**Interfaces:**
- Consumes: `normalizeXAIToolParameters()` from Task 1.
- Produces internally: `ToolCatalogState`, containing retained names, quarantined names, and whether any tools remain after sanitization.
- Produces: valid top-level, namespace, and `additional_tools` catalogs with no structured `tool_choice` entry targeting only a quarantined function.

- [ ] **Step 1: Write failing quarantine and tool-choice tests**

Add these tests to `sanitize-responses.test.ts`:

```ts
test('quarantines one cyclic function and resets its named tool choice', () => {
  const cleaned = decode(
    sanitizeXAIGrokResponsesBody(
      encode({
        tools: [
          {
            type: 'function',
            name: 'broken',
            parameters: {
              type: 'object',
              oneOf: [{ $ref: '#/$defs/loop' }],
              $defs: { loop: { $ref: '#/$defs/loop' } },
            },
          },
          { type: 'function', name: 'healthy', parameters: { type: 'object', properties: {} } },
        ],
        tool_choice: { type: 'function', name: 'broken' },
      }),
    ),
  );

  expect(cleaned.tools).toEqual([
    { type: 'function', name: 'healthy', parameters: { type: 'object', properties: {} } },
  ]);
  expect(cleaned.tool_choice).toBe('auto');
});

test('sanitizes namespace and additional_tools catalogs and filters allowed_tools', () => {
  const unsafe = { type: 'function', name: 'unsafe', parameters: { oneOf: [{ type: 'string' }] } };
  const cleaned = decode(
    sanitizeXAIGrokResponsesBody(
      encode({
        tools: [
          {
            type: 'namespace',
            name: 'agents',
            tools: [unsafe, { type: 'function', name: 'spawn', parameters: { type: 'object' } }],
          },
        ],
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [unsafe, { type: 'custom', name: 'exec', format: { type: 'text' } }],
          },
          { role: 'user', content: 'continue' },
        ],
        tool_choice: {
          type: 'allowed_tools',
          mode: 'required',
          tools: [
            { type: 'function', name: 'unsafe' },
            { type: 'function', name: 'spawn' },
            { type: 'custom', name: 'exec' },
          ],
        },
      }),
    ),
  );

  expect(cleaned.tools[0].tools.map((tool: { name: string }) => tool.name)).toEqual(['spawn']);
  expect(cleaned.input[0].tools.map((tool: { name: string }) => tool.name)).toEqual(['exec']);
  expect(cleaned.tool_choice).toEqual({
    type: 'allowed_tools',
    mode: 'required',
    tools: [
      { type: 'function', name: 'spawn' },
      { type: 'custom', name: 'exec' },
    ],
  });
});

test('removes empty catalogs and a forced choice when no tools remain', () => {
  const cleaned = decode(
    sanitizeXAIGrokResponsesBody(
      encode({
        tools: [
          {
            type: 'namespace',
            name: 'broken_namespace',
            tools: [{ type: 'function', name: 'broken', parameters: { $ref: 'https://example.test/schema' } }],
          },
        ],
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [{ type: 'function', name: 'broken', parameters: { type: 'string' } }],
          },
          { role: 'user', content: 'continue' },
        ],
        tool_choice: { type: 'function', name: 'broken' },
      }),
    ),
  );

  expect(cleaned).not.toHaveProperty('tools');
  expect(cleaned.input).toEqual([{ role: 'user', content: 'continue' }]);
  expect(cleaned).not.toHaveProperty('tool_choice');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src/runtime/sanitize-responses/sanitize-responses.test.ts
```

Expected: FAIL because failed normalization is not yet wired to remove a tool, namespace/`additional_tools` catalogs are not pruned, and `tool_choice` is not synchronized.

- [ ] **Step 3: Add catalog state and fail-closed pruning**

Replace the old mutating `sanitizeTools()` loop with these internal data shapes and behaviors:

```ts
type ToolCatalogState = {
  readonly kept: Set<string>;
  readonly removed: Set<string>;
};

function toolAliases(name: string, namespace?: string): readonly string[] {
  return namespace === undefined ? [name] : [name, `${namespace}__${name}`];
}

function remember(set: Set<string>, name: unknown, namespace?: string): void {
  if (typeof name !== 'string' || name.length === 0) return;
  for (const alias of toolAliases(name, namespace)) set.add(alias);
}

function sanitizeToolList(tools: unknown, state: ToolCatalogState, namespace?: string): void {
  if (!Array.isArray(tools)) return;
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = asRecord(tools[index]);
    if (tool === undefined) continue;
    const type = tool['type'];
    const name = tool['name'];
    if (type === 'namespace') {
      const childNamespace = typeof name === 'string' ? (namespace === undefined ? name : `${namespace}__${name}`) : namespace;
      sanitizeToolList(tool['tools'], state, childNamespace);
      if (!Array.isArray(tool['tools']) || tool['tools'].length === 0) tools.splice(index, 1);
      continue;
    }
    if (type !== 'function' || !Object.hasOwn(tool, 'parameters')) {
      remember(state.kept, name, namespace);
      continue;
    }
    const parameters = normalizeXAIToolParameters(tool['parameters']);
    if (parameters === undefined) {
      remember(state.removed, name, namespace);
      tools.splice(index, 1);
      continue;
    }
    tool['parameters'] = parameters;
    remember(state.kept, name, namespace);
  }
}
```

In `sanitizeXAIGrokResponsesBody()`:

1. Create `{ kept: new Set(), removed: new Set() }`.
2. Sanitize `body['tools']`; delete the field if the resulting array is empty.
3. Walk `body['input']` backwards. For each object with `type === 'additional_tools'`, sanitize its `tools`; remove the input item if its list becomes empty.
4. Call `sanitizeToolChoice(body, state)` after all catalogs have been processed.

- [ ] **Step 4: Implement structured tool-choice repair**

Add these helpers in `sanitize-responses.ts`:

```ts
function wasOnlyRemoved(name: unknown, state: ToolCatalogState): boolean {
  return typeof name === 'string' && state.removed.has(name) && !state.kept.has(name);
}

function hasTools(body: JsonObject): boolean {
  if (Array.isArray(body['tools']) && body['tools'].length > 0) return true;
  const input = body['input'];
  return (
    Array.isArray(input) &&
    input.some((item) => {
      const record = asRecord(item);
      return record?.['type'] === 'additional_tools' && Array.isArray(record['tools']) && record['tools'].length > 0;
    })
  );
}

function resetToolChoice(body: JsonObject): void {
  if (hasTools(body)) body['tool_choice'] = 'auto';
  else Reflect.deleteProperty(body, 'tool_choice');
}

function sanitizeToolChoice(body: JsonObject, state: ToolCatalogState): void {
  const choice = asRecord(body['tool_choice']);
  if (choice === undefined) return;
  if (choice['type'] === 'allowed_tools' && Array.isArray(choice['tools'])) {
    choice['tools'] = choice['tools'].filter((entry) => !wasOnlyRemoved(asRecord(entry)?.['name'], state));
    if (choice['tools'].length === 0) resetToolChoice(body);
    return;
  }
  if (wasOnlyRemoved(choice['name'], state)) resetToolChoice(body);
}
```

Do not alter `strict` on retained tools. Do not add a warning containing tool names or schemas.

- [ ] **Step 5: Run the sanitizer and package tests**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src/runtime/sanitize-responses/sanitize-responses.test.ts
rtk bun run --filter @aio-proxy/plugin-xai-grok test:unit
```

Expected: all pass. Invalid functions disappear independently, namespace and `additional_tools` containers stay valid, custom tools survive for the later compiler, and structured choice contains no quarantined-only name.

- [ ] **Step 6: Commit quarantine behavior**

```bash
rtk git add packages/plugins/xai-grok/src/runtime/sanitize-responses
rtk git commit -m "fix(xai-grok): quarantine incompatible function tools" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Prove runtime dispatch and publish the fix

**Files:**
- Modify: `packages/plugins/xai-grok/src/runtime/runtime.test.ts:69-137`
- Create: `.changeset/xai-grok-tool-schema-compatibility.md`

**Interfaces:**
- Consumes: `createXAIGrokDynamicFetch()` and `sanitizeXAIGrokResponsesBody()` behavior from Tasks 1-2.
- Produces: an integration assertion that the request captured by the xAI host mock contains only explicit object branches.
- Produces: patch release notes for `@aio-proxy/plugin-xai-grok` and `aio-proxy`.

- [ ] **Step 1: Extend the real dynamic-fetch test with a referenced root union**

In `injects CLI identity, sanitizes Responses fields, and compiles custom tools before dispatch`, change the `lookup` declaration from `{ type: 'object' }` to:

```ts
{
  type: 'function',
  name: 'lookup',
  strict: true,
  parameters: {
    type: 'object',
    oneOf: [{ $ref: '#/$defs/by_id' }, { $ref: '#/$defs/by_name' }],
    $defs: {
      by_id: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      by_name: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
}
```

Change the captured-body expectation for `lookup` to:

```ts
{
  type: 'function',
  name: 'lookup',
  strict: true,
  parameters: {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
    ],
  },
}
```

- [ ] **Step 2: Run the runtime boundary test**

Run:

```bash
rtk bun test packages/plugins/xai-grok/src/runtime/runtime.test.ts
```

Expected: PASS. The mock host receives `strict: true`, two explicit object alternatives, no `$ref`, and no `$defs`; headers, abort signal, custom-tool compilation, and history conversion remain unchanged.

- [ ] **Step 3: Add the patch changeset**

Create `.changeset/xai-grok-tool-schema-compatibility.md` with exactly:

```md
---
'@aio-proxy/plugin-xai-grok': patch
'aio-proxy': patch
---

Preserve Codex function-tool schemas on xAI Grok OAuth requests by resolving local references and explicit object unions, while isolating only tools whose schemas cannot be converted safely.
```

- [ ] **Step 4: Run repository verification**

Run in order:

```bash
rtk bun run --filter @aio-proxy/plugin-xai-grok test:unit
rtk bun run check
rtk bun run preflight
rtk git diff --check
```

Expected: every command exits 0. `preflight` completes oxlint, oxfmt checking, and all unit tests without changing files.

- [ ] **Step 5: Review the final diff for scope**

Run:

```bash
rtk git status --short
rtk git diff --stat
rtk git diff -- packages/plugins/xai-grok/src/runtime/sanitize-responses packages/plugins/xai-grok/src/runtime/runtime.test.ts .changeset/xai-grok-tool-schema-compatibility.md
```

Expected: only the xAI sanitizer/tests, the runtime boundary test, and the changeset are part of the implementation. There is no Codex, shared protocol, dependency, config, database, or dashboard change.

- [ ] **Step 6: Commit the runtime proof and release note**

```bash
rtk git add packages/plugins/xai-grok/src/runtime/runtime.test.ts .changeset/xai-grok-tool-schema-compatibility.md
rtk git commit -m "test(xai-grok): cover referenced Codex tool schemas" -m "Co-authored-by: Codex <noreply@openai.com>"
```
