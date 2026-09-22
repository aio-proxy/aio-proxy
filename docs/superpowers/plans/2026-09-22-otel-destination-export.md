# Otel Destination Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user add OTLP trace destinations in Settings and export the spans aio-proxy already records, without changing the local traces page.

**Architecture:** `server.otel.destinations` is parsed with the rest of the config. A delegator is registered once beside `BufferingSpanProcessor` and swaps its active `BatchSpanProcessor`s on config commit. Each destination gets an official OTLP/HTTP exporter. Export uses a read-only span view filtered with the same `ALLOWED_ATTRIBUTES` as local storage.

**Tech Stack:** Bun, Zod, `@opentelemetry/sdk-trace-node` 2.10.0, `@opentelemetry/exporter-trace-otlp-http` 0.221.0, `@opentelemetry/exporter-trace-otlp-proto` 0.221.0, TanStack Form, existing dashboard settings cards.

## Global Constraints

- Activity cap is 8 destinations. Header cap is 16. URL max length is 2048. Header name max length is 256. Header value max length is 4096.
- `contentType` is `json` or `protobuf`, default `json`.
- `compression` passed to every exporter is `'none'`. `timeoutMillis` passed to every exporter is `10000`.
- Request URL is the configured URL with no `/v1/traces` suffix. Do not use `proxy` or `proxyBackup`.
- Do not modify `process.env`. Do not set `service.version` from the tracer placeholder `0.0.0`. Set resource `service.name` to `aio-proxy`.
- Do not add an application-level retry or a persistent replay queue. Do not call `provider.shutdown()` from `ServerState.close()`.
- Destination routing uses the active set at `onEnd()`. A reload may split one trace. v1 does not pin a trace to the destinations it started with.
- Logs may contain the destination index, URL origin, category (`export_failed`, `partial_success`, `destination_unavailable`), and an HTTP status code only when the SDK exposes one as an integer from 100 to 599. Logs must not contain path, query, headers, response bodies, `error.message`, or the raw exporter error.
- `{{env.NAME}}` checks apply only under `server.otel`. Other config fields keep today's missing-env behavior.
- When `OTEL_EXPORTER_OTLP_HEADERS` or `OTEL_EXPORTER_OTLP_TRACES_HEADERS` is a non-empty string and `destinations` is non-empty, reject the config. Empty destinations stay valid.
- User-facing copy goes through `@aio-proxy/i18n`. These strings stay identical in every locale: `Otel`, `OTLP`, `JSON`, `Protobuf`, `Add Destination`, `+ Add Header`.
- Dashboard inputs use TanStack Form. One React component per file, declared as `React.FC`.
- Exporter dependencies are added only on `@aio-proxy/server`, not the root catalog.
- HTTP tests run under Bun against `Bun.serve`. Do not mock the OTLP exporter in those tests. Lifecycle tests may inject a processor factory.
- Changeset targets `aio-proxy` plus every internal package this feature edits, all `minor`.

## File structure

- `packages/types/src/config/otel.ts` — authoring and runtime Zod schemas for `server.otel`. No Node APIs.
- `packages/types/src/config/otel.test.ts` — schema acceptance and rejection.
- `packages/types/src/config/config.ts` — add `otel` to `ServerConfigSchema` and `ServerConfigAuthoringSchema`.
- `packages/core/src/config/otel-guard.ts` — missing-env references, Node header-value checks, OTLP header-env rejection. Called only from `parseRuntimeConfig`.
- `packages/core/src/config/otel-guard.test.ts` — those three guards.
- `packages/server/src/dashboard-routes/provider-secrets/provider-secrets.ts` — mask destination `url` values.
- `packages/server/src/request-tracing/otel-export/safe-span.ts` — read-only filtered span. Does not mutate the SDK span and does not call `spanToRecord`.
- `packages/server/src/request-tracing/otel-export/delegator.ts` — one `SpanProcessor` whose active set is replaced by `sync`.
- `packages/server/src/request-tracing/otel-export/exporters.ts` — official JSON and protobuf exporters.
- `packages/server/src/request-tracing/otel-export/otel-export.ts` — process singleton used by the trace runtime.
- `packages/server/src/request-tracing/runtime.ts` — construct the provider with the buffering processor and the delegator, and set `service.name`.
- `packages/server/src/server-state/lifecycle.ts` — `sync` after a successful snapshot swap; `stop` from `close()`.
- `packages/server/src/server-state/index.ts` — `sync` the initial config before the state is returned.
- `packages/server/src/server-log.ts` — `otel.export` log event.
- `packages/server/src/dashboard-routes/settings/settings.ts` — view, authored round-trip, mutation.
- `packages/dashboard/src/modules/settings/components/settings-otel-group/` — card, dialog, test.
- `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json` — copy.

`spanToRecord` stays the SQLite projection. The export view shares `ALLOWED_ATTRIBUTES` only.

---

### Task 1: Config schema

**Files:**
- Create: `packages/types/src/config/otel.ts`
- Create: `packages/types/src/config/otel.test.ts`
- Modify: `packages/types/src/config/config.ts` (`ServerConfigSchema`, `ServerConfigAuthoringSchema`)

**Interfaces:**
- Consumes: `ConfigTemplateStringSchema` from `packages/types/src/provider.ts`.
- Produces: `ServerOtelSchema`, `ServerOtelAuthoringSchema`, `OtelDestination` (`{ url: string; contentType: 'json' | 'protobuf'; headers: Record<string, string> }`). `Config.server.otel.destinations` is always present after `ConfigSchema.parse`.

- [ ] **Step 1: Write the failing test**

Add `packages/types/src/config/otel.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { ConfigAuthoringSchema, ConfigSchema } from '..';

const destination = {
  url: 'https://collector.example/v1/traces',
  headers: { Authorization: 'Bearer secret' },
};

test('defaults to no otel destinations and json content type', () => {
  const config = ConfigSchema.parse({ providers: {} });
  expect(config.server.otel.destinations).toEqual([]);
  const parsed = ConfigSchema.parse({ server: { otel: { destinations: [destination] } }, providers: {} });
  expect(parsed.server.otel.destinations[0]?.contentType).toBe('json');
});

test('accepts an authoring template in the url and header', () => {
  const parsed = ConfigAuthoringSchema.safeParse({
    server: {
      otel: {
        destinations: [
          {
            url: 'https://collector.example/{{env.OTLP_PATH}}',
            headers: { Authorization: 'Bearer {{env.OTLP_TOKEN}}' },
          },
        ],
      },
    },
    providers: {},
  });
  expect(parsed.success).toBe(true);
});

test.each([
  ['ftp', 'ftp://collector.example/v1/traces'],
  ['userinfo', 'https://user:pass@collector.example/v1/traces'],
  ['fragment', 'https://collector.example/v1/traces#x'],
])('rejects an otel url with %s', (_label, url) => {
  expect(ConfigSchema.safeParse({ server: { otel: { destinations: [{ url }] } }, providers: {} }).success).toBe(false);
});

test('rejects a ninth destination, a 17th header, a forbidden header, and a duplicate header name', () => {
  const nine = Array.from({ length: 9 }, () => destination);
  expect(ConfigSchema.safeParse({ server: { otel: { destinations: nine } }, providers: {} }).success).toBe(false);
  const headers = Object.fromEntries(Array.from({ length: 17 }, (_value, index) => [`X-${index}`, 'v']));
  expect(
    ConfigSchema.safeParse({ server: { otel: { destinations: [{ ...destination, headers }] } }, providers: {} })
      .success,
  ).toBe(false);
  expect(
    ConfigSchema.safeParse({
      server: { otel: { destinations: [{ ...destination, headers: { 'Content-Type': 'text/plain' } }] } },
      providers: {},
    }).success,
  ).toBe(false);
  expect(
    ConfigSchema.safeParse({
      server: { otel: { destinations: [{ ...destination, headers: { Authorization: 'a', authorization: 'b' } }] } },
      providers: {},
    }).success,
  ).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/types/src/config/otel.test.ts`

Expected: FAIL because `config.server.otel` is undefined.

- [ ] **Step 3: Write the schema**

Create `packages/types/src/config/otel.ts`:

```ts
import { z } from 'zod';

import { ConfigTemplateStringSchema } from '../provider';

export const OtelContentTypeSchema = z.enum(['json', 'protobuf']);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const FORBIDDEN_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'host',
  'connection',
  'transfer-encoding',
  'user-agent',
]);

const HeaderNameSchema = z.string().min(1).max(256).regex(HEADER_NAME);
const HeaderValueSchema = z.string().min(1).max(4096);

function refineOtelUrl(value: string, context: z.RefinementCtx): void {
  if (value.length > 2048) {
    context.addIssue({ code: 'custom', message: 'OTLP URL is too long' });
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'OTLP URL is invalid' });
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    context.addIssue({ code: 'custom', message: 'OTLP URL must be http or https' });
  }
  if (url.username !== '' || url.password !== '') {
    context.addIssue({ code: 'custom', message: 'OTLP URL cannot contain userinfo' });
  }
  if (url.hash !== '') {
    context.addIssue({ code: 'custom', message: 'OTLP URL cannot contain a fragment' });
  }
}

function refineHeaders(headers: Readonly<Record<string, string>>, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const name of Object.keys(headers)) {
    const folded = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(folded)) {
      context.addIssue({ code: 'custom', message: `Header ${name} is reserved`, path: [name] });
    }
    if (seen.has(folded)) {
      context.addIssue({ code: 'custom', message: `Duplicate header ${name}`, path: [name] });
    }
    seen.add(folded);
  }
}

const OtelHeadersSchema = z.record(HeaderNameSchema, HeaderValueSchema).default({}).superRefine(refineHeaders);

const OtelDestinationSchema = z.object({
  url: z.string().superRefine(refineOtelUrl),
  contentType: OtelContentTypeSchema.default('json'),
  headers: OtelHeadersSchema,
});

const OtelDestinationAuthoringSchema = z.object({
  url: z.union([z.string().superRefine(refineOtelUrl), ConfigTemplateStringSchema]),
  contentType: OtelContentTypeSchema.default('json'),
  headers: z
    .record(HeaderNameSchema, z.union([HeaderValueSchema, ConfigTemplateStringSchema]))
    .default({})
    .superRefine(refineHeaders),
});

export const ServerOtelSchema = z.object({
  destinations: z.array(OtelDestinationSchema).max(8).default([]),
});

export const ServerOtelAuthoringSchema = z.object({
  destinations: z.array(OtelDestinationAuthoringSchema).max(8).default([]),
});

export type OtelDestination = z.output<typeof OtelDestinationSchema>;
```

A template such as `https://host/{{env.PATH}}` fails `new URL` and then matches `ConfigTemplateStringSchema`. Zod tries the union branches in order.

In `packages/types/src/config/config.ts`, import the two server otel schemas and add `otel: ServerOtelSchema.prefault({})` to `ServerConfigSchema`, and `otel: ServerOtelAuthoringSchema.prefault({})` to `ServerConfigAuthoringSchema`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/types/src/config/otel.test.ts packages/types/src/config/config.test.ts`

Expected: PASS. The authoring-template case passes. Existing config tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/config/otel.ts packages/types/src/config/otel.test.ts packages/types/src/config/config.ts
git commit -m "feat(types): add server.otel destination schema"
```

---

### Task 2: Parse-time otel guards

**Files:**
- Create: `packages/core/src/config/otel-guard.ts`
- Create: `packages/core/src/config/otel-guard.test.ts`
- Modify: `packages/core/src/config/parse-runtime-config.ts`

**Interfaces:**
- Consumes: raw config object and the same `env` argument `parseRuntimeConfig` already takes.
- Produces: `assertOtelConfig(value: unknown, env: Readonly<Record<string, string | undefined>>): void`. It throws `TypeError` before `ConfigSchema.parse`. Messages name the variable or the header name, never the secret value or the raw template.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';

import { parseRuntimeConfig } from './parse-runtime-config';

const base = { providers: {} };

test('rejects a missing otel env var even when the expanded string stays non-empty', () => {
  expect(() =>
    parseRuntimeConfig(
      {
        ...base,
        server: { otel: { destinations: [{ url: 'https://collector.example/v1/traces', headers: { Authorization: 'Bearer {{env.MISSING}}' } }] } },
      },
      {},
    ),
  ).toThrow(/MISSING/u);
});

test.each([
  'https://collector.example/{{env.MISSING}}/v1/traces',
  'https://collector.example/v1/traces?token={{env.MISSING}}',
])('rejects a missing variable embedded in %s', (url) => {
  expect(() => parseRuntimeConfig({ ...base, server: { otel: { destinations: [{ url }] } } }, {})).toThrow(/MISSING/u);
});

test('still accepts a missing env var outside server.otel', () => {
  const config = parseRuntimeConfig({ ...base, server: { apiKeys: [{ key: 'prefix-{{env.MISSING}}-suffix' }] } }, {});
  expect(config.server.apiKeys[0]?.key).toBe('prefix--suffix');
});

test('rejects CR and LF in an expanded otel header before the value is stored', () => {
  expect(() =>
    parseRuntimeConfig(
      { ...base, server: { otel: { destinations: [{ url: 'https://collector.example/v1/traces', headers: { Authorization: 'Bearer bad\rvalue' } }] } } },
      {},
    ),
  ).toThrow(TypeError);
});

test('rejects destinations when an OTLP header environment variable is set', () => {
  expect(() =>
    parseRuntimeConfig(
      { ...base, server: { otel: { destinations: [{ url: 'https://collector.example/v1/traces' }] } } },
      { OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer other' },
    ),
  ).toThrow(/OTEL_EXPORTER_OTLP_HEADERS/u);
});

test('allows that environment variable when there are no destinations', () => {
  expect(parseRuntimeConfig(base, { OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'Authorization=Bearer other' }).server.otel.destinations).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/core/src/config/otel-guard.test.ts`

Expected: FAIL. The missing-variable case currently parses, because `Bearer {{env.MISSING}}` expands to a non-empty string.

- [ ] **Step 3: Implement the guard**

`otel-guard.ts` walks only `server.otel`. For every string under `destinations[].url` and `destinations[].headers.*`, parse it with `@handlebars/parser` the same way `resolve-config-templates.ts` does. Collect `{{env.NAME}}` references. If a statement is not a content or a single `env.NAME` mustache, throw the existing `Unsupported config template` error. For each collected name, `Object.hasOwn(env, name)` must be true and `env[name]` must be a string of length greater than 0. Otherwise throw `new TypeError(\`Missing or empty environment variable ${name} referenced by server.otel\`)`.

If `destinations` is a non-empty array, and either `OTEL_EXPORTER_OTLP_HEADERS` or `OTEL_EXPORTER_OTLP_TRACES_HEADERS` is a string with length greater than 0, throw `new TypeError('OTEL_EXPORTER_OTLP_HEADERS cannot be combined with server.otel destinations')` using the variable name that was set.

After `resolveConfigTemplates`, walk the expanded header values and call `validateHeaderValue` from `node:http` with the header name and value. On throw, replace it with `new TypeError(\`Invalid server.otel header ${name}\`)` so the value is not in the message.

`parseRuntimeConfig` becomes:

```ts
export function parseRuntimeConfig(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  assertOtelConfig(value, env);
  const expanded = withDigitServerPort(resolveConfigTemplates(value, env));
  assertExpandedOtelHeaders(expanded);
  return ConfigSchema.parse(expanded);
}
```

`assertOtelConfig` runs before expansion, on the raw object. `assertExpandedOtelHeaders` runs after expansion.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/core/src/config/otel-guard.test.ts packages/core/src/config/resolve-config-templates.test.ts`

Expected: PASS. The resolver tests are unchanged: a missing variable outside otel still expands to an empty string.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/otel-guard.ts packages/core/src/config/otel-guard.test.ts packages/core/src/config/parse-runtime-config.ts
git commit -m "feat(core): reject unsafe otel destination config"
```

---

### Task 3: Redact destination URLs

**Files:**
- Modify: `packages/server/src/dashboard-routes/provider-secrets/provider-secrets.ts`
- Modify: `packages/server/src/dashboard-routes/provider-secrets/provider-secrets.test.ts`

**Interfaces:**
- Consumes: the existing `redactSecrets` walk. `headers` is already a secret boundary, so destination header values already become `****`.
- Produces: a string property named `url` is replaced with `****` at any depth. Current config objects have no other `url` field. Do not mask `baseURL`.

- [ ] **Step 1: Write the failing test**

In `provider-secrets.test.ts`, inside the `redactSecrets` describe:

```ts
test('masks an otel destination url and its headers', () => {
  expect(
    redactSecrets({
      server: {
        otel: {
          destinations: [
            {
              url: 'https://collector.example/v1/traces?token=secret',
              contentType: 'json',
              headers: { Authorization: 'Bearer secret' },
            },
          ],
        },
      },
    }),
  ).toEqual({
    server: {
      otel: {
        destinations: [{ url: '****', contentType: 'json', headers: { Authorization: '****' } }],
      },
    },
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/src/dashboard-routes/provider-secrets/provider-secrets.test.ts`

Expected: FAIL because `url` is returned unchanged.

- [ ] **Step 3: Mask `url`**

In `redactSecrets`, when `typeof value === 'string'` and `key === 'url'`, return `'****'` before `maskSecret`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/server/src/dashboard-routes/provider-secrets/provider-secrets.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/dashboard-routes/provider-secrets/provider-secrets.ts packages/server/src/dashboard-routes/provider-secrets/provider-secrets.test.ts
git commit -m "fix(server): redact otel destination urls"
```

---

### Task 4: Safe span and delegator lifecycle

**Files:**
- Create: `packages/server/src/request-tracing/otel-export/safe-span.ts`
- Create: `packages/server/src/request-tracing/otel-export/safe-span.test.ts`
- Create: `packages/server/src/request-tracing/otel-export/delegator.ts`
- Create: `packages/server/src/request-tracing/otel-export/delegator.test.ts`
- Modify: `packages/server/src/server-log.ts` (add the log variant to `ServerLog`)

**Interfaces:**
- Consumes: `ALLOWED_ATTRIBUTES` from `packages/server/src/request-tracing/semantic/semantic.ts`. `ReadableSpan` from `@opentelemetry/sdk-trace-node`.
- Produces:
  - `toExportableSpan(span: ReadableSpan): ReadableSpan`
  - `OtelDestination` re-exported from `@aio-proxy/types` (`url`, `contentType`, `headers`)
  - `createOtelExportDelegator(options: { logger: ServerLogSink; createProcessor: (destination: OtelDestination, index: number) => SpanProcessor; timeoutMs?: number }): OtelExportDelegator`
  - `OtelExportDelegator.sync(destinations: readonly OtelDestination[]): void`
  - `OtelExportDelegator.stop(): void`
  - Log shape: `{ event: 'otel.export'; category: 'export_failed' | 'partial_success' | 'destination_unavailable'; index: number; origin: string; statusCode?: number }`

- [ ] **Step 1: Write the failing safe-span test**

Use `NodeTracerProvider` the same way `buffering-span-processor.test.ts` does. Start a span, set attribute `gen_ai.request.model` to `ok-model`, set attribute `secret.prompt` to `sentinel-prompt`, call `recordException(new Error('sentinel-stack'))`, and `setStatus({ code: SpanStatusCode.ERROR, message: 'sentinel-status' })`. End it. `toExportableSpan(readable)` keeps `gen_ai.request.model`, drops `secret.prompt`, drops `exception.stacktrace` from the exception event, and has `status.message` undefined. The original span's attributes still contain `secret.prompt`. `startTime` and `endTime` are the same HrTime tuples as the original.

- [ ] **Step 2: Run the safe-span test to verify it fails**

Run: `bun test packages/server/src/request-tracing/otel-export/safe-span.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement `toExportableSpan`**

Return a new object. Copy `name`, `kind`, `parentSpanContext`, `startTime`, `endTime`, `duration`, `ended`, `resource`, `instrumentationScope`, `droppedEventsCount`, and `droppedLinksCount`. `spanContext` is `() => span.spanContext()`. `status` is `{ code: span.status.code }`. Attributes, event attributes, and link attributes keep only keys in `ALLOWED_ATTRIBUTES`. Event `name` and `time` stay. Link `context` stays. Do not call any method that writes to `span`.

- [ ] **Step 4: Write the failing delegator test**

Inject `createProcessor`. Each fake records `onEnd` spans and returns `{ onStart() {}, onEnd(span) { received.push(span); }, forceFlush: async () => {}, shutdown }`.

Assert all of these:

- Two identical destinations create two processors. One ended span is delivered to both. Deleting one index from the next `sync` calls `shutdown` on exactly one of them, and the next span reaches only the survivor.
- Reversing header key order does not call `createProcessor` again.
- A child ended while destination A is active is not delivered to B. After `sync` to B, the root ended later is delivered only to B.
- `createProcessor` throwing for index 1 logs `destination_unavailable` with that index and `origin` `https://b.example`. Index 0 still receives the next span. The previous processor for index 1 is not put back.
- `shutdown` returning `Promise.reject(new Error('secret-body'))` does not emit an `unhandledRejection`. The logger line does not contain `secret-body`.
- `stop()` returns on the same turn when `shutdown` never resolves. A span ended after `stop()` is not delivered.
- A span whose instrumentation scope is not `@aio-proxy/server` is not delivered.
- Nine rapid replacements leave at most 8 shutdown promises in the delegator's draining list. Every `shutdown` rejection is caught.

- [ ] **Step 5: Implement the delegator**

`sync` builds a key from `url`, `contentType`, and header entries sorted by name. Walk the current slots and keep a slot when its key is still requested, decrementing a count so two identical keys stay two slots. Slots that are no longer requested leave the active array immediately, then `retire(slot)` starts `shutdown()` without awaiting it.

New keys call `createProcessor`. A throw logs `destination_unavailable` and does not insert a slot. Do not reinsert a retired slot.

`retire` pushes a promise that races `processor.shutdown()` with `timeoutMs` (default `10_000`). `.catch` logs `export_failed` only when `httpStatusCode(error)` returns a number; the logged object is exactly the `otel.export` fields. The catch swallows the error. When the race settles, remove that promise from the draining list. If the list already has 8 promises, do not push another one; still attach `.catch` to the untracked shutdown.

`onEnd` returns immediately when `stopped` is true or `span.instrumentationScope.name` is not `@aio-proxy/server`. Otherwise it calls `onEnd(toExportableSpan(span))` on each active processor and ignores processor exceptions.

`stop` sets `stopped`, moves every active slot through `retire`, and clears the active array. It does not return a promise.

`httpStatusCode` reads `error.code` and `error.data?.code` only. Return the number when it is an integer from 100 through 599. Otherwise return undefined. Never read `error.message`.

`originOf` is `new URL(destination.url).origin`.

Add the log type to `ServerLog` in `server-log.ts`.

- [ ] **Step 6: Run both tests**

Run: `bun test packages/server/src/request-tracing/otel-export/safe-span.test.ts packages/server/src/request-tracing/otel-export/delegator.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/request-tracing/otel-export packages/server/src/server-log.ts
git commit -m "feat(server): add the otel export delegator"
```

---

### Task 5: Official exporters and HTTP behavior

**Files:**
- Create: `packages/server/src/request-tracing/otel-export/exporters.ts`
- Create: `packages/server/src/request-tracing/otel-export/http.test.ts`
- Modify: `packages/server/package.json`

**Interfaces:**
- Consumes: `createOtelExportDelegator` and `OtelDestination` from Task 4.
- Produces: `createDestinationProcessor(destination: OtelDestination): SpanProcessor`. JSON uses `OTLPTraceExporter` from `@opentelemetry/exporter-trace-otlp-http`. Protobuf uses `OTLPTraceExporter` from `@opentelemetry/exporter-trace-otlp-proto`. Both are constructed with `{ url: destination.url, headers: destination.headers, compression: 'none', timeoutMillis: 10_000 }` and wrapped in `new BatchSpanProcessor(exporter)`.

- [ ] **Step 1: Add the dependencies**

From `packages/server`:

```bash
bun add --exact @opentelemetry/exporter-trace-otlp-http@0.221.0 @opentelemetry/exporter-trace-otlp-proto@0.221.0 @opentelemetry/resources@2.10.0
```

`@opentelemetry/resources` is imported in Task 6. Adding it here keeps the install in one commit with the exporters. Do not add these to the root catalog.

- [ ] **Step 2: Write the failing HTTP test**

`http.test.ts` starts `Bun.serve` on `127.0.0.1:0` and records method, url, content-type, content-encoding, headers, and body. Build the delegator with `createProcessor: createDestinationProcessor`. End a span through a `NodeTracerProvider` whose only processor is that delegator and whose tracer name is `@aio-proxy/server`. Call `delegator.forceFlush()` so the test does not wait for the batch timer.

Assert:

- JSON destination `http://127.0.0.1:${port}/custom/traces` receives `POST /custom/traces`, not `/v1/traces`. Body `JSON.parse` contains the span name `export-me` and `gen_ai.request.model`. It does not contain `sentinel-prompt` or `sentinel-status`. `Authorization` is the configured value. A header that was not configured is absent. `content-encoding` is null. `service.name` in the resource is `aio-proxy`.
- Protobuf destination sends `content-type: application/x-protobuf`. `new TextDecoder('utf-8', { fatal: false }).decode(body)` contains `export-me`. `JSON.parse` of that body throws.
- With `process.env.OTEL_EXPORTER_OTLP_COMPRESSION = 'gzip'` and `process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1'`, the request still arrives at the configured server without `content-encoding`. Restore both env vars in `finally`.
- Two identical destinations to the same server produce two POSTs for one span.
- A server that always returns 400 receives one POST. The log is `{ event: 'otel.export', category: 'export_failed', index: 0, origin }` and its JSON does not contain the response body `secret-body`.
- A server that returns 503 with `Retry-After: 0` once and then 200 receives at least two POSTs.
- A server that returns 200 and `{"partialSuccess":{"rejectedSpans":1,"errorMessage":"secret-body"}}` does not receive a second POST for that batch. The log category is `partial_success` and the line does not contain `secret-body`.

Install the partial-success diag bridge in `exporters.ts` before creating exporters. Match only the exact first diag argument `Received Partial Success response:` from `@opentelemetry/otlp-exporter-base` 0.221.0. Ignore the second argument. Emit one `partial_success` log per currently active destination, using that destination's index and origin. Forward every other diag call to the logger that was installed before this bridge. Call `diag.setLogger` once.

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/server/src/request-tracing/otel-export/http.test.ts`

Expected: FAIL because `createDestinationProcessor` does not exist.

- [ ] **Step 4: Implement the exporters and the diag bridge**

`createDestinationProcessor` selects the JSON or protobuf exporter from `destination.contentType`, passes the four constructor fields above, and returns `new BatchSpanProcessor(exporter)`. Do not pass `httpAgentOptions`, `userAgent`, or any proxy agent.

The diag bridge lives in `bindOtelDiag(getActive: () => readonly { index: number; origin: string }[], logger: ServerLogSink): void`. The delegator's default export path calls it when the first real processor is created. The HTTP test uses that default path, so the bridge is armed.

Do not log `error.message`. For the 400 case, include `statusCode` only if `httpStatusCode` from Task 4 can see it on the SDK error. If this SDK version does not put `400` on `error.code`, assert the category and the absence of `secret-body`, and do not fail the test for a missing status code.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/server/src/request-tracing/otel-export/http.test.ts`

Expected: PASS. The 503 retry test finishes well under 10 seconds because `Retry-After: 0` retries immediately.

- [ ] **Step 6: Commit**

```bash
git add packages/server/package.json bun.lock packages/server/src/request-tracing/otel-export
git commit -m "feat(server): export otel spans over OTLP HTTP"
```

If `bun.lock` is at the repo root, add that path instead.

---

### Task 6: Wire the delegator into the process

**Files:**
- Create: `packages/server/src/request-tracing/otel-export/otel-export.ts`
- Create: `packages/server/src/request-tracing/otel-export/index.ts`
- Modify: `packages/server/src/request-tracing/runtime.ts`
- Modify: `packages/server/src/request-tracing/index.ts`
- Modify: `packages/server/src/server-state/lifecycle.ts` (`commitConfig` after the snapshot swap, `assembleServerState` `close`)
- Modify: `packages/server/src/server-state/index.ts` (after the initial snapshot is current, before `return assembleServerState`)

**Interfaces:**
- Consumes: `createOtelExportDelegator`, `createDestinationProcessor`.
- Produces:
  - `syncOtelDestinations(destinations: readonly OtelDestination[], logger: ServerLogSink): void`
  - `stopOtelExport(): void`
  - `TraceRuntime` also exposes `exporter: OtelExportDelegator`

- [ ] **Step 1: Write the failing wiring test**

Create `packages/server/src/request-tracing/otel-export/wire.test.ts`. It calls `syncOtelDestinations([], logger)` and then `getTraceRuntime()`. The provider's span processors include the buffering processor first. Ending a span through `getTraceRuntime().tracer` still reaches the buffering processor when no destination is configured, and does not throw. `stopOtelExport()` does not return a promise and does not throw. A second `syncOtelDestinations` with a destination whose exporter constructor would throw logs `destination_unavailable` and does not throw out of `syncOtelDestinations`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/src/request-tracing/otel-export/wire.test.ts`

Expected: FAIL because `syncOtelDestinations` is not exported.

- [ ] **Step 3: Implement the wiring**

`runtime.ts`:

```ts
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { createProcessOtelDelegator } from './otel-export';

export function getTraceRuntime(): TraceRuntime {
  if (runtime !== undefined) return runtime;
  const processor = new BufferingSpanProcessor();
  const exporter = createProcessOtelDelegator();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'aio-proxy' }),
    sampler: new AlwaysOnSampler(),
    spanProcessors: [processor, exporter],
  });
  provider.register();
  runtime = { processor, exporter, tracer: provider.getTracer('@aio-proxy/server', '0.0.0') };
  return runtime;
}
```

`otel-export.ts` holds the delegator created by `getTraceRuntime`. `syncOtelDestinations` calls `getTraceRuntime().exporter.sync(destinations)` inside `try/catch` and, on an unexpected throw, logs `destination_unavailable` for index `-1` and origin `unknown`. It never rethrows. `stopOtelExport` calls `runtime?.exporter.stop()` without creating the runtime when it was never used.

`createProcessOtelDelegator` passes `createDestinationProcessor` and a logger set later by `syncOtelDestinations`. The first sync installs the server logger. Until a server exists, the logger is a no-op.

At the end of `commitConfig`, after the api-key warning and before `return retired`:

```ts
syncOtelDestinations(config.server.otel.destinations, runtime.logger);
```

In `createServerState`, immediately before `return assembleServerState(...)`:

```ts
syncOtelDestinations(options.config.server.otel.destinations, logger);
```

In `assembleServerState`'s `close()`, add `() => stopOtelExport()` to the close list. Do not await it. Do not call `provider.shutdown()`.

Export `syncOtelDestinations` and `stopOtelExport` from `request-tracing/index.ts`.

- [ ] **Step 4: Run the wiring test and the existing trace runtime tests**

Run: `bun test packages/server/src/request-tracing`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/request-tracing packages/server/src/server-state/lifecycle.ts packages/server/src/server-state/index.ts
git commit -m "feat(server): apply otel destinations on config commit"
```

---

### Task 7: Settings API

**Files:**
- Modify: `packages/types/src/dashboard/control-plane/control-plane.ts`
- Modify: `packages/types/src/dashboard/control-plane/control-plane.test.ts` if a strict-key test lists settings fields
- Modify: `packages/server/src/dashboard-routes/settings/settings.ts`
- Modify: `packages/server/src/dashboard-routes/settings/settings.test.ts`

**Interfaces:**
- Consumes: `OtelDestination` shape from Task 1. `parseRuntimeConfig` from Task 2.
- Produces: `DashboardSettingsView.otel.destinations` and optional `DashboardSettingsMutation.otel.destinations`. `PUT` with only `otel` returns `restartRequired: false`. `PUT` with `otel` and `port` returns `restartRequired: true`. `GET` returns the authored template, not the expanded secret.

- [ ] **Step 1: Write the failing settings test**

In `settings.test.ts`, using `withSettingsFixture`:

```ts
test('round-trips an authored otel destination without requiring a restart', async () => {
  await withSettingsFixture(async ({ routes, configPath }) => {
    const response = await routes.request('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        otel: {
          destinations: [
            {
              url: 'https://collector.example/v1/traces',
              contentType: 'json',
              headers: { Authorization: 'Bearer {{env.SETTINGS_OTLP_TOKEN}}' },
            },
          ],
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(false);
    expect(body.settings.otel.destinations).toEqual([
      {
        url: 'https://collector.example/v1/traces',
        contentType: 'json',
        headers: { Authorization: 'Bearer {{env.SETTINGS_OTLP_TOKEN}}' },
      },
    ]);
    const stored = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(stored.server.otel.destinations[0].headers.Authorization).toBe('Bearer {{env.SETTINGS_OTLP_TOKEN}}');
    expect(stored.server.futureServer).toBe('server-preserved');
  });
});

test('a port change still requires a restart when otel is in the same request', async () => {
  await withSettingsFixture(async ({ routes }) => {
    const response = await routes.request('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        port: 9_318,
        otel: { destinations: [] },
      }),
    });
    const body = await response.json();
    expect(body.restartRequired).toBe(true);
  });
});

test('a missing otel env var is config_rejected and leaves the file unchanged', async () => {
  await withSettingsFixture(async ({ routes, configPath }) => {
    const before = readFileSync(configPath, 'utf8');
    const response = await routes.request('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        otel: {
          destinations: [
            { url: 'https://collector.example/v1/traces', headers: { Authorization: 'Bearer {{env.MISSING_OTLP}}' } },
          ],
        },
      }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});
```

Set `process.env.SETTINGS_OTLP_TOKEN` inside this test's fixture copy, the same way `SETTINGS_API_KEY` is set, so the successful template resolves during `parseRuntimeConfig`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/src/dashboard-routes/settings/settings.test.ts`

Expected: FAIL with 422 `config_rejected` on the successful case, because `otel` is not in `DashboardSettingsMutationSchema`.

- [ ] **Step 3: Implement the settings contract**

Add to `DashboardSettingsViewSchema`:

```ts
otel: z.strictObject({
  destinations: z.array(
    z.strictObject({
      url: z.string().min(1),
      contentType: z.enum(['json', 'protobuf']),
      headers: z.record(z.string(), z.string()),
    }),
  ),
}),
```

Add the same object as optional on `DashboardSettingsMutationSchema`.

`settingsView` includes `otel: { destinations: authoredOtel(authored) }`. Read `server.otel.destinations` from the config file the same way `authoredApiKeys` reads `server.apiKeys`. If the file is missing or unreadable, use `config.server.otel.destinations`. Drop entries whose `url` is not a non-empty string. Default a missing `contentType` to `json` and missing `headers` to `{}`.

`applySettingsMutation`: when `mutation.otel` is present, set `server.otel.destinations` to that array and preserve any other keys already on `server.otel`. Do not assign `restartRequired` in this branch.

- [ ] **Step 4: Run the settings tests**

Run: `bun test packages/server/src/dashboard-routes/settings/settings.test.ts packages/types/src/dashboard/control-plane/control-plane.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/dashboard/control-plane packages/server/src/dashboard-routes/settings
git commit -m "feat(server): save otel destinations from settings"
```

---

### Task 8: Settings card

**Files:**
- Create: `packages/dashboard/src/modules/settings/components/settings-otel-group/settings-otel-group.tsx`
- Create: `packages/dashboard/src/modules/settings/components/settings-otel-group/settings-otel-dialog.tsx`
- Create: `packages/dashboard/src/modules/settings/components/settings-otel-group/index.ts`
- Create: `packages/dashboard/src/modules/settings/components/settings-otel-group/settings-otel-group.test.tsx`
- Modify: `packages/dashboard/src/modules/settings/components/settings-form/settings-form.tsx` (render the card after `SettingsLogsGroup`)
- Modify: `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.test.tsx` (the fixture `settings` object needs `otel: { destinations: [] }`)
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`

**Interfaces:**
- Consumes: `SettingsSave` and `DashboardSettingsView.otel` from Task 7. `m['dashboard.settings.otel_*']`.
- Produces: `SettingsOtelGroup`, rendered between the logs card and `SettingsMutationStatus`.

- [ ] **Step 1: Add the messages and write the failing UI test**

Under `dashboard.settings` in every locale, add:

| key | en | zh-Hans |
| --- | --- | --- |
| `otel_group` | Otel integration | Otel 集成 |
| `otel_description` | Configure Otel to report trace data to OpenTelemetry endpoints. | 配置 Otel 集成来自动向 OpenTelemetry 终结点报告跟踪数据。 |
| `otel_add` | Add Destination | Add Destination |
| `otel_add_title` | Add Otel Destination | 添加 Otel 终结点 |
| `otel_edit_title` | Edit Otel Destination | 编辑 Otel 终结点 |
| `otel_endpoint` | OTLP Traces Endpoint | OTLP Traces Endpoint |
| `otel_endpoint_required` | Endpoint is required | 必须填写终结点。 |
| `otel_content_type` | Content Type | Content Type |
| `otel_headers` | Custom Headers (Optional) | Custom Headers (Optional) |
| `otel_header_name` | Header name | Header name |
| `otel_header_value` | Header value | Header value |
| `otel_add_header` | + Add Header | + Add Header |
| `otel_create` | Create | 创建 |
| `otel_save` | Save | 保存 |
| `otel_edit` | Edit | 编辑 |
| `otel_delete` | Delete | 删除 |

`otel_add`, `otel_endpoint`, `otel_content_type`, `otel_headers`, `otel_header_name`, `otel_header_value`, and `otel_add_header` are the same string in zh-Hant, ja, and ko as in en. Translate the rest: zh-Hant uses 「Otel 整合」 and 「新增 Otel 終端點」; ja uses 「Otel 連携」 and 「Otel 宛先を追加」; ko uses 「Otel 통합」 and 「Otel 대상 추가」. Endpoint-required, edit, delete, create, and save follow that locale's existing settings wording (`必須`, `必須`, `편집` / `삭제` / `만들기` / `저장`).

Run `bun run i18n:compile`.

`settings-otel-group.test.tsx` renders `SettingsOtelGroup` with `destinations: []` and a `onSave` spy. The empty card has the description and `Add Destination`, and no header value. Clicking `Add Destination` and submitting with an empty endpoint shows the required message and does not call `onSave`. Filling `https://collector.example/v1/traces`, choosing `Protobuf`, adding header `Authorization` / `Bearer secret`, and submitting calls:

```ts
onSave({
  otel: {
    destinations: [
      {
        url: 'https://collector.example/v1/traces',
        contentType: 'protobuf',
        headers: { Authorization: 'Bearer secret' },
      },
    ],
  },
})
```

A second render with that destination shows the URL and `Protobuf`, and does not show `Bearer secret`. Edit replaces that row. Delete calls `onSave` with `destinations: []`. With 8 destinations, `Add Destination` is disabled. The sixteenth header row disables `+ Add Header`. A header row with only a name blocks submit. When `onSave` is called and the parent leaves the dialog open because the mutation failed, the URL the user typed is still in the field.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --filter @aio-proxy/dashboard exec rstest run src/modules/settings/components/settings-otel-group/settings-otel-group.test.tsx`

Expected: FAIL because the component file does not exist.

- [ ] **Step 3: Implement the card and dialog**

`SettingsOtelGroup` is a `Card` with `data-testid="settings-group-otel"`. The header action is `Add Destination`. Each row is the URL, a `Badge` with `JSON` or `Protobuf`, Edit, and Delete. Delete calls `onSave({ otel: { destinations: without that index } })` immediately.

`SettingsOtelDialog` owns a TanStack form:

```ts
{ url: '', contentType: 'json' as 'json' | 'protobuf', headers: [{ id, name: '', value: '' }] }
```

Empty header rows are omitted. A row with only one side sets a field error and does not call `onSave`. Empty `url` sets the endpoint-required error. Submit calls `onSave` with the whole array, either appending or replacing `editingIndex`. The dialog stays open when `disabled` is true after a failed save; the parent passes `disabled={mutation.isPending}` and closes the dialog only in `onSave`'s `onSuccess`.

Wire it in `SettingsForm` after `SettingsLogsGroup`:

```tsx
<SettingsOtelGroup disabled={mutation.isPending} settings={settings} onSave={save} />
```

Update the settings fixture in `settings-page.test.tsx` so `otel: { destinations: [] }` satisfies `DashboardSettingsView`.

- [ ] **Step 4: Run the dashboard settings tests**

Run: `bun run --filter @aio-proxy/dashboard exec rstest run src/modules/settings`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/modules/settings packages/i18n
git commit -m "feat(dashboard): add otel destinations to settings"
```

---

### Task 9: Changeset

**Files:**
- Create: `.changeset/otel-destination-export.md`

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1–8.
- Produces: one minor changeset for `aio-proxy`, `@aio-proxy/types`, `@aio-proxy/core`, `@aio-proxy/server`, and `@aio-proxy/dashboard`.

- [ ] **Step 1: Write the note**

```md
---
'aio-proxy': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/dashboard': minor
---

Settings can send the traces aio-proxy already records to OTLP endpoints. Add a destination URL, choose JSON or protobuf, and set headers. Export stays on when a destination fails, and the local traces page is unchanged.
```

- [ ] **Step 2: Commit**

```bash
git add .changeset/otel-destination-export.md
git commit -m "chore: note otel destination export"
```

---

## Spec coverage

- Schema, caps, forbidden headers, templates: Task 1.
- Missing env vars, header characters, OTLP header env rejection: Task 2.
- Redacted config/CLI url and headers: Task 3. Header redaction already comes from the `headers` boundary.
- Filtered export view, delegator lifecycle, split trace, drain cap, `stop` without waiting: Task 4.
- Real OTLP JSON and protobuf, no path suffix, no inherited compression or endpoint, duplicate destinations, 400, 503 retry, partial success log: Task 5.
- `service.name`, commit and startup sync, `close`: Task 6.
- Settings round-trip, `restartRequired`, `config_rejected` leaves the file: Task 7.
- Settings card copy and interactions: Task 8.
- User-facing release note: Task 9.

Out of scope stays out of scope: metrics, logs, prompt capture, inbound trace context, sampling, proxy, per-destination switches, and an export health page.
