# ChatGPT Codex Request Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize OpenAI Responses request bodies at the ChatGPT plugin boundary so the internal Codex endpoint always receives `store: false` and list-form input.

**Architecture:** Keep the shared Responses adapter unchanged. In `createOpenAIChatGPTDynamicFetch`, rewrite only POST-like `/responses` bodies before the existing credentialed host fetch, using the same `input_text` message shape produced by the installed OpenAI AI SDK.

**Tech Stack:** TypeScript, Bun, Bun test, Fetch `Request`/`Headers` APIs.

## Global Constraints

- Modify only the ChatGPT plugin runtime and its colocated test.
- Preserve array input and unrelated request fields.
- Do not add dependencies or abstractions outside the plugin runtime.
- Remove stale `content-length` and `content-encoding` headers when the JSON body changes.

---

### Task 1: Normalize ChatGPT Codex Responses requests

**Files:**
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts`
- Modify: `packages/plugins/openai-chatgpt/src/runtime/runtime.ts`

**Interfaces:**
- Consumes: `createOpenAIChatGPTDynamicFetch(credentials, fetcher, credentialFetcher?)`
- Produces: the same `typeof fetch` function, with Codex-specific request-body normalization before invoking `fetchOpenAIResponses`

- [x] **Step 1: Write the failing request-capture test**

Add a test beside the existing dynamic-fetch test:

```typescript
test('normalizes Responses requests for the Codex backend', async () => {
  const calls: FetchCall[] = [];
  const dynamicFetch = createOpenAIChatGPTDynamicFetch(staticCredentialPort(credential()), captureFetch(calls));

  await dynamicFetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-encoding': 'identity',
      'content-length': '1',
    },
    body: JSON.stringify({ model: 'gpt-5.6-luna', input: 'hello', store: true, stream: true }),
  });

  const call = requiredCall(calls, 0);
  expect(JSON.parse(call.body)).toEqual({
    model: 'gpt-5.6-luna',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    store: false,
    stream: true,
  });
  expect(call.headers.get('content-encoding')).toBeNull();
  expect(call.headers.get('content-length')).toBeNull();
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
bun run --filter @aio-proxy/plugin-openai-chatgpt test:unit
```

Expected: 30 tests pass and the new test fails because the captured body still contains string `input` and `store: true`.

- [x] **Step 3: Implement the minimal plugin-local normalization**

In `createOpenAIChatGPTDynamicFetch`, normalize only requests whose original path ends in `/responses` and whose method can carry a body:

```typescript
const responsesRequest = shouldRewriteResponsesBody(request);
const body = responsesRequest ? await rewriteResponsesBody(request, headers) : request.body;

return await fetchOpenAIResponses(rewriteCodexUrl(request.url), {
  method: request.method,
  headers,
  ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body }),
  signal: init?.signal ?? (input instanceof Request ? input.signal : request.signal),
  redirect: request.redirect,
});
```

Add the private helpers in the same file:

```typescript
function shouldRewriteResponsesBody(request: Request): boolean {
  return (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.body !== null &&
    new URL(request.url).pathname.endsWith('/responses')
  );
}

async function rewriteResponsesBody(request: Request, headers: Headers): Promise<string> {
  const value: unknown = await request.json();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ChatGPT Codex Responses request body must be an object');
  }
  const body = value as Record<string, unknown>;
  headers.delete('content-encoding');
  headers.delete('content-length');
  return JSON.stringify({
    ...body,
    store: false,
    ...(typeof body.input === 'string'
      ? { input: [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }] }
      : {}),
  });
}
```

- [x] **Step 4: Run the plugin tests and verify GREEN**

Run:

```bash
bun run --filter @aio-proxy/plugin-openai-chatgpt test:unit
```

Expected: all ChatGPT runtime tests pass with no warnings.

- [x] **Step 5: Run repository verification**

Run:

```bash
bun run check
bun run --filter @aio-proxy/plugin-openai-chatgpt test
bun run --filter @aio-proxy/plugin-openai-chatgpt test:artifact
```

Expected: formatting, lint/type checks, and the plugin test suite pass.

- [x] **Step 6: Commit the implementation**

```bash
git add packages/plugins/openai-chatgpt/src/runtime/runtime.ts packages/plugins/openai-chatgpt/src/runtime/runtime.test.ts docs/superpowers/plans/2026-07-28-chatgpt-codex-request-normalization.md
git commit -m "fix(openai-chatgpt): normalize Codex responses requests" -m "Co-authored-by: Codex <noreply@openai.com>"
```
