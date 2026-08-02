# Revert Bun to 1.3.14 + Proxy ReadableStream Body Workaround — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the build toolchain back to reproducible Bun `1.3.14` while keeping proxied streaming passthrough working, by buffering `ReadableStream` request bodies in the proxy fetch wrapper instead of relying on the Bun 1.4 runtime.

**Architecture:** The `api`-provider proxy path funnels every upstream request through `createProxyFetch` (the sole proxy egress; `materialize.ts` wraps all api fetches with it). Bun 1.3.x silently drops a `ReadableStream` request body when `fetch` is given the `proxy` option, so we materialize such bodies to bytes *only on the proxy branch* before delegating. Response streaming is untouched. With the bug worked around in code, we revert every Bun version reference from the rolling `canary` tag to the reproducible stable `1.3.14`.

**Tech Stack:** Bun 1.3.14, TypeScript, `bun:test`, Turborepo, Changesets, Docker (`oven/bun` images).

## Global Constraints

- Bun runtime floor: `1.3.14` (was `>=1.4.0-canary.1`). Exact pin `bun@1.3.14`.
- The compiled binary embeds the **build-time** Bun runtime, so `.bun-version` in release CI is what ships to users — it MUST be `1.3.14`, not `canary`.
- `createProxyFetch` MUST remain a no-op passthrough (return `fetchImpl` unchanged) when no proxy is configured — zero overhead in the common case.
- The workaround MUST only affect the **request body** on the proxy branch; **response** streaming (SSE passthrough) MUST remain fully streaming.
- Handwritten non-test implementation files stay under 300 lines.
- Every user-facing changeset MUST target a product package (`aio-proxy` and/or `@aio-proxy/plugin-sdk`); a `core` change targets both `@aio-proxy/core` and `aio-proxy`.
- Do not run `changeset version`/`publish` by hand — CI owns both.
- Completion gate: `bun install --frozen-lockfile` then `bun run preflight` (oxlint + oxfmt check + all unit tests).
- **Reversion comments (user requirement):** Every workaround and every Bun `1.3.14` pin introduced by this plan MUST carry an inline comment stating explicitly what to change once Bun 1.4.0 stable is released — i.e. delete the request-body buffering workaround (Bun 1.4 fixes the proxy body drop) and bump the pins to `1.4.0`. The comment references issue #128.

---

### Task 1: Buffer ReadableStream request bodies on the proxy branch

**Files:**
- Modify: `packages/core/src/provider/proxy-fetch.ts`
- Test: `packages/core/src/provider/proxy-fetch.test.ts`

**Interfaces:**
- Consumes: `globalThis.fetch` signature (`ProviderFetch = typeof globalThis.fetch`).
- Produces: `createProxyFetch(proxy: string | undefined, fetchImpl?: ProviderFetch): ProviderFetch` — unchanged public signature. When `proxy` is set and `init.body` is a `ReadableStream`, the wrapper awaits the stream into an `ArrayBuffer` and forwards that buffer as the body; all other bodies (string, `Uint8Array`, `undefined`) forward unchanged. Still returns `fetchImpl` by reference when `proxy === undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/provider/proxy-fetch.test.ts` (keep the 3 existing tests):

```typescript
test('materializes a ReadableStream request body to bytes when a proxy is set', async () => {
  const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  const spy = (async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response();
  }) as typeof globalThis.fetch;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"hello":'));
      controller.enqueue(new TextEncoder().encode('"world"}'));
      controller.close();
    },
  });

  const proxyFetch = createProxyFetch('http://proxy.example:8080', spy);
  await proxyFetch('https://upstream.example/v1', { method: 'POST', body });

  const forwarded = calls[0]?.init;
  expect(forwarded?.proxy).toBe('http://proxy.example:8080');
  expect(forwarded?.body instanceof ReadableStream).toBe(false);
  const sent = await new Response(forwarded?.body as BodyInit).text();
  expect(sent).toBe('{"hello":"world"}');
});

test('forwards a non-stream body unchanged when a proxy is set', async () => {
  const calls: Array<RequestInit | undefined> = [];
  const spy = (async (_input: unknown, init?: RequestInit) => {
    calls.push(init);
    return new Response();
  }) as typeof globalThis.fetch;

  const proxyFetch = createProxyFetch('http://proxy.example:8080', spy);
  await proxyFetch('https://upstream.example/v1', { method: 'POST', body: '{"a":1}' });

  expect(calls[0]?.body).toBe('{"a":1}');
  expect(calls[0]?.proxy).toBe('http://proxy.example:8080');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test src/provider/proxy-fetch.test.ts`
Expected: the two new tests FAIL (current wrapper forwards the `ReadableStream` as-is, so `forwarded?.body instanceof ReadableStream` is `true`).

- [ ] **Step 3: Write minimal implementation**

Replace the body of `packages/core/src/provider/proxy-fetch.ts` with:

```typescript
export type ProviderFetch = typeof globalThis.fetch;

/**
 * Wraps a fetch implementation to route requests through a URL-only HTTP(S)
 * proxy via Bun's `proxy` fetch option. Returns the implementation unchanged
 * when no proxy is configured so callers pay no overhead in the common case.
 *
 * Bun 1.3.x silently drops a `ReadableStream` request body when `fetch` is
 * given the `proxy` option, which hangs proxied streaming passthrough for
 * `api` providers until timeout. We materialize a streamed request body to a
 * buffer before delegating so the body survives the proxied request. Only the
 * request body is buffered; the response is returned untouched and stays
 * streaming.
 *
 * TODO(bun-1.4.0, issue #128): Bun 1.4.0 fixes this proxy body drop. Once the
 * toolchain is pinned to Bun >= 1.4.0, delete the `ReadableStream` buffering
 * branch below and restore the direct passthrough:
 *   return ((input, init) => fetchImpl(input, { ...init, proxy })) as ProviderFetch;
 * (the wrapper can also go back to being non-async).
 */
export function createProxyFetch(
  proxy: string | undefined,
  fetchImpl: ProviderFetch = globalThis.fetch,
): ProviderFetch {
  if (proxy === undefined) return fetchImpl;
  return (async (input: Parameters<ProviderFetch>[0], init?: Parameters<ProviderFetch>[1]) => {
    // TODO(bun-1.4.0, issue #128): remove this buffering branch when on Bun >= 1.4.0.
    if (init?.body instanceof ReadableStream) {
      const body = await new Response(init.body).arrayBuffer();
      return fetchImpl(input, { ...init, body, proxy });
    }
    return fetchImpl(input, { ...init, proxy });
  }) as ProviderFetch;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun test src/provider/proxy-fetch.test.ts`
Expected: all 5 tests PASS (3 existing + 2 new). The existing `forwards the proxy option...` test still passes because a `POST` with no body takes the non-stream path (`{ method: 'POST', proxy }`).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/provider/proxy-fetch.ts packages/core/src/provider/proxy-fetch.test.ts
git commit -m "core: buffer ReadableStream request body on proxy branch to survive Bun 1.3.x proxy body drop"
```

---

### Task 2: Revert every Bun version reference to 1.3.14

**Files:**
- Modify: `.bun-version`
- Modify: `package.json` (`engines.bun`, `packageManager`)
- Modify: `Dockerfile` (two build stages + the revert comment)
- Modify: `CONTRIBUTING.md` (Bun version line)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime; this task is the version pin that ships the Task 1 workaround via the stable runtime.
- Produces: a reproducible `1.3.14` toolchain across CI, local, and Docker.

- [ ] **Step 1: Set `.bun-version`**

Replace the entire contents of `.bun-version` with the single version line (this file is read by `setup-bun` and must contain only the version — no comment):

```
1.3.14
```

- [ ] **Step 2: Update root `package.json`**

- `engines.bun`: `">=1.4.0-canary.1"` → `">=1.3.14"`
- `packageManager`: `"bun@1.4.0-canary.1"` → `"bun@1.3.14"`

(Leave the `@types/bun` catalog entry at `^1.3.14` — it already satisfies 1.3.14.)

JSON does not allow comments, so record the 1.4 reversion intent in the changeset (Task 3) and in the `Dockerfile`/`CONTRIBUTING.md`/code comments instead. Do NOT add a `//` comment to `package.json`.

- [ ] **Step 3: Update `Dockerfile`**

- Both `FROM ... oven/bun:canary-alpine AS prune` and `... AS build` → `oven/bun:1.3.14-alpine`.
- Replace the adjacent comment (currently "Revert to oven/bun:1 once 1.4.0 is stable.") with one that explains: the image is pinned to `1.3.14`; the Bun 1.3.x proxy `ReadableStream` body-drop bug is worked around in `createProxyFetch` (buffering the request body), NOT by the runtime version; and once Bun 1.4.0 stable ships (issue #128) bump these bases to `oven/bun:1.4.0-alpine` and drop the code workaround. Example:

```dockerfile
# Pinned to Bun 1.3.14 (reproducible stable). The Bun 1.3.x bug where fetch with
# a proxy drops a ReadableStream request body is worked around in
# createProxyFetch (packages/core/src/provider/proxy-fetch.ts), not by the
# runtime. TODO(bun-1.4.0, issue #128): bump to oven/bun:1.4.0-alpine and remove
# that workaround once Bun 1.4.0 stable is released.
```

- [ ] **Step 4: Update `CONTRIBUTING.md`**

Change the Bun requirement line to state `Bun 1.3.14 or later`, and rewrite the note so it reflects the code-level workaround AND the 1.4 reversion plan, e.g.:

```
- Bun 1.3.14 or later. Bun 1.3.x silently drops a `ReadableStream` request body when `fetch` uses a proxy; aio-proxy works around this in `createProxyFetch` by buffering the request body on the proxy path, so proxied streaming passthrough works on 1.3.14. Once Bun 1.4.0 stable is released (issue #128) this workaround can be removed and the pins bumped to 1.4.0.
```

- [ ] **Step 5: Refresh the lockfile-tracked toolchain and verify install**

Run: `bun install --frozen-lockfile`
Expected: succeeds with no lockfile drift. If `--frozen-lockfile` fails solely because `packageManager` changed, run `bun install` once to update the lockfile, then re-run `bun install --frozen-lockfile` to confirm it is clean, and include any lockfile change in the commit.

- [ ] **Step 6: Commit**

```bash
git add .bun-version package.json Dockerfile CONTRIBUTING.md bun.lock
git commit -m "chore: pin Bun toolchain to reproducible 1.3.14 (proxy body bug handled in code)"
```

---

### Task 3: Rewrite the changeset to describe the code workaround

**Files:**
- Modify: `.changeset/upgrade-bun-1.4-proxy-body.md`

**Interfaces:**
- Consumes: the behavior delivered by Tasks 1–2.
- Produces: a release note that attributes the fix to the proxy-fetch buffering workaround, targeting `@aio-proxy/core` + `aio-proxy` (patch), per CLAUDE.md changeset rules.

- [ ] **Step 1: Rewrite the changeset body**

Keep the front-matter targets and bump level:

```markdown
---
'@aio-proxy/core': patch
'aio-proxy': patch
---

core: fix proxied streaming passthrough dropping the request body. Bun 1.3.x
silently discards a `ReadableStream` request body when `fetch` uses a proxy, so
`api` providers with a `proxy` configured hung until timeout on streaming
requests (e.g. `openai-response` passthrough). `createProxyFetch` now buffers a
streamed request body to bytes before sending it through the proxy, so the body
survives without changing the streaming response. This lets the build toolchain
stay on the reproducible Bun 1.3.14 release.
```

Rename the file if desired (optional) to reflect the new intent, e.g. `.changeset/proxy-body-buffer-workaround.md`; keep the same front-matter if renamed.

- [ ] **Step 2: Commit**

```bash
git add .changeset/
git commit -m "chore: changeset for proxy body buffering workaround on Bun 1.3.14"
```

---

### Task 4: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Clean install on the new toolchain**

Run: `bun install --frozen-lockfile`
Expected: PASS.

- [ ] **Step 2: Run preflight**

Run: `bun run preflight`
Expected: oxlint clean, oxfmt check clean, all unit tests pass (including the 5 `proxy-fetch` tests).

- [ ] **Step 3: Sanity-check the version pin is coherent**

Run: `grep -R "canary" .bun-version package.json Dockerfile CONTRIBUTING.md`
Expected: no matches (all Bun references now point at `1.3.14`).

- [ ] **Step 4: Report follow-up on issue #128**

Do NOT auto-edit the issue. In the final summary, note that issue #128 ("Pin Bun to 1.4.0 stable once released") is now partially obsoleted: the proxy body bug is handled in code, so the 1.4 pin is no longer required for correctness. Recommend the maintainer either close #128 or repurpose it to "optionally adopt Bun 1.4.0 when released" and drop the workaround then.

---

## Notes on Verification Limits

`@aio-proxy/cli build:binary` cross-compiles four targets by downloading per-platform Bun binaries. Local runs may fail to download due to network restrictions; this is not a regression. On CI, `bun-*-v1.3.14` target binaries **do exist** (1.3.14 is a published stable release), which is exactly what unblocks the release job that failed on the nonexistent `v1.4.0` targets.
