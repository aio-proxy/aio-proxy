# Provider Request Transforms Design

## Goal

Add Provider-level outbound request transformation comparable to CPA
`payload.override`, new-api ParamOverride, and CCH request filters without
binding aio-proxy's configuration to a native runtime or an arbitrary scripting
language.

The first release supports request headers and JSON request bodies. It provides
one configuration format that can be edited either visually or as JSON. Future
response transforms may reuse the same concepts, but response handling is not
part of this release.

## Product Decisions

- Transforms are configured per Provider ID.
- The execution engine is a restricted Mingo profile.
- Conditions and updates are stored as Mongo-style JSON AST, not source code.
- Conditions support field-to-field comparisons and computed expressions.
- Rules execute in configuration order against the current outbound request,
  matching CPA `payload.override` semantics.
- A matched rule applies immediately, so later rules see earlier changes and
  the last matching write to a field wins.
- Conditions and updates may explicitly read the immutable original request
  when a rule needs a pre-transform value.
- A transform failure fails only the current Provider attempt and participates
  in the existing Provider fallback loop.
- The runtime remains pure JavaScript. Node-API, WASM, and Bun FFI are excluded
  from the initial implementation.
- The Dashboard uses React Query Builder's shadcn registry for conditions and a
  small custom stage editor for updates.
- Visual and JSON modes edit the same restricted AST. JSON mode is not an
  escape hatch for unsupported Mingo operators.
- The first release does not include a sample-request dry-run UI.

## Non-goals

- Arbitrary JavaScript, `$where`, `$function`, or custom runtime code.
- Arbitrary MongoDB/Mingo operators outside the documented profile.
- Response header or response body transforms.
- Streaming/SSE response-body transforms.
- A general-purpose policy engine or decision graph editor.
- Runtime-selectable JS/native executors.
- CPA `payload.default`, `default-raw`, and `override-raw` as separate config
  sections. Static JSON values already cover the raw distinction; missing-only
  defaults can be designed later if requested.
- Copy, Move, Append, or Merge as separate visual action types. These remain
  expressible through Set expressions when needed.

## Provider Configuration

Each Provider may define an ordered request transform list:

```yaml
id: openai
transforms:
  request:
    - name: cap-output
      when:
        $and:
          - request.model:
              $regex: "^gpt-"
          - $expr:
              $gt:
                - "$request.body.max_output_tokens"
                - 8192
      update:
        - $set:
            request.body.max_output_tokens:
              $min:
                - "$request.body.max_output_tokens"
                - 8192
        - $set:
            request.headers:
              $setField:
                field: x-upstream-model
                input: "$request.headers"
                value: "$request.body.model"
        - $set:
            request.headers:
              $unsetField:
                field: x-internal-token
                input: "$request.headers"
        - $unset:
            request.body.store
```

`transforms.request` is optional. Each rule has:

- `name?: string`: an optional diagnostic and UI label.
- `when?: object`: a restricted Mingo query. Omission means match every request.
- `update`: a non-empty ordered array of restricted Mingo update stages.

Rule array order is significant. No separate `enabled` field is needed in the
first release; removing a rule or an empty transform list disables it.

## Evaluation Document

The runtime captures the outbound request as an immutable snapshot before any
rule executes:

```ts
{
  provider: {
    id: string,
    kind: string,
    protocol?: string,
  },
  request: {
    model: string,
    requestedModel: string,
    sourceProtocol: string,
    targetProtocol?: string,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: JsonValue,
  },
}
```

Before each condition or update stage, the runtime builds a fresh Mingo
evaluation document:

```ts
{
  provider: ProviderContext,
  original: OutboundRequest,
  request: OutboundRequest,
}
```

The immutable snapshot is kept outside Mingo. `original` and `request` are
separate `structuredClone()` results, so copying an object from `$original`
into `$request` cannot create a reference that mutates the snapshot. After an
update stage, only a cloned `request` is retained as current; the evaluation
document and any mutations to its `original` copy are discarded.

The Provider ID and kind come from the materialized Provider. `model` is the
candidate model ID for the current Provider attempt, while `requestedModel` is
the client-facing model ID before Provider selection. Source protocol comes
from the active protocol adapter, and target protocol comes from the
attempt-scoped runtime context rather than being guessed from a
protocol-specific body. The existing attempt context already carries Provider
ID and model ID for outbound logging; it is extended with target protocol
metadata rather than introducing protocol branching into route handlers.

Headers are represented with lowercase names. Repeated request header values
follow the Fetch `Headers` combined-value behavior. The body is present only
when it is a JSON payload that the transform needs to inspect or modify.

## Match Semantics

Rules follow CPA `payload.override` ordering:

1. Evaluate the next rule's `when` against the current `$request`.
2. If it matches, apply its stages immediately in order.
3. Continue to the next rule with the resulting current request.

A rule can therefore make a later rule start or stop matching, and later writes
win. Conditions and update expressions use `$request...` for current values and
may use `$original...` when they intentionally need the pre-transform value.

Missing fields use Mingo query semantics. A missing field normally causes a
comparison not to match. `$exists` is available when absence itself is the
condition.

## Restricted Mingo Profile

### Query operators

The initial condition builder supports:

- logical grouping: `$and`, `$or`, `$nor`, and field-level `$not`;
- comparison: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, and `$nin`;
- existence: `$exists`;
- string matching: a JSON string `$regex` with `$options` limited to supported
  non-stateful flags (`i`, `m`, `s`, and `u`);
- computed comparison: `$expr`.

The Dashboard may expose friendly names such as Equals, Contains, Starts with,
or Ends with, but serialization must produce only this canonical query subset.
CPA-style model and header patterns use `*` as a wildcard in the visual editor
and serialize to an escaped `$regex`. JSON mode may use the general `$regex`
form directly; Provider configuration is trusted operational configuration, so
the initial release does not add a second regex engine or timeout layer.

### Expression functions

Expressions contain field references, JSON literal values, and these initial
functions:

- arithmetic: add, subtract, multiply, divide, modulo, min, max, and absolute
  value;
- strings: concatenate, uppercase, and lowercase;
- conditional: condition and null fallback;
- arrays and objects: concatenate arrays and merge objects.

They serialize to the corresponding Mingo aggregation operators such as
`$add`, `$multiply`, `$min`, `$concat`, `$cond`, `$ifNull`, `$concatArrays`, and
`$mergeObjects`.

`$getField`, `$setField`, `$unsetField`, and `$regexMatch` are reserved for
generated header operations so header names containing `.` or other Mongo
path-significant characters remain valid. Header equality uses `$expr` with
`$getField`; Header Pattern and Regex use the canonical generated
`$getField`/`$regexMatch` shape. Header Exists and Does not exist use `$expr`
with `$getField` wrapped by `$ifNull` and compared with `null`, which is safe
because Fetch header values are strings. These operators are not exposed as
arbitrary expression functions.

Static values and expressions are distinct in the visual editor. The serializer
uses `$literal` whenever a static string or object would otherwise be interpreted
as a field reference or operator expression.

### Update stages

Only `$set` and `$unset` pipeline stages are allowed. Each stage represents one
visual action and must have exactly one target.

- `$set` creates or replaces body fields and may use any allowed expression.
- `$unset` contains one string path, removes that body field, and treats a
  missing path as a no-op.
- Header Set and Remove actions serialize as `$set` of the entire
  `request.headers` object using exactly one `$setField` or `$unsetField` whose
  input is directly `$request.headers`.
- A `$set` targeting `request.headers` must contain exactly that one generated
  header operation. Nested `$setField` or `$unsetField` chains and arbitrary
  replacement of the header object are rejected.
- Direct dot-path updates below `request.headers` are rejected so header names
  retain case-insensitive HTTP semantics and support literal dots.
- Update targets outside `request.body` and `request.headers` are rejected.
- Body update targets use Mongo dot-path semantics. Literal body keys containing
  `.` or beginning with `$` are outside the initial visual profile.
- Multi-target `$set` objects and `$unset` arrays are rejected. This preserves
  stage ordering exactly when switching between cards and JSON instead of
  splitting one Mongo stage into several stages with different semantics.
- `$project`, `$replaceRoot`, `$replaceWith`, classic modifier documents, and
  collection update operations are not part of the profile.

The narrow stage set still covers copying a field, moving it through Set then
Remove, numeric limits, string concatenation, array append, and object merge.

## Runtime Integration

The transform executes as a Provider-specific Fetch decorator. This is below
protocol routing but above the actual network Fetch, so it applies consistently
to:

- same-protocol raw API passthrough;
- API Providers bridged through the AI SDK;
- direct AI SDK Providers;
- OAuth model traffic.

It must not apply to OAuth authorization, catalog, quota, or other auxiliary
plugin requests.

For non-OAuth Providers, the decorator is assembled where
`packages/server/src/provider-runtime/materialize.ts` creates the Provider Fetch.
For OAuth Providers, the model Fetch passed during snapshot materialization is
decorated per Provider. This preserves the current rule that route files do not
branch by Provider kind.

The wrapper order is:

```text
request transform -> observed/wire logging -> proxy or runtime fetch
```

The transform therefore runs first, and outbound logging observes the actual
request sent upstream. A transform failure occurs before the observed network
Fetch and is reported by the normal Provider-attempt exception path.

Each compiled `when` uses `Query.test()` against a fresh evaluation document
containing the immutable original snapshot and the current request. A matched
rule applies one stage at a time through
`updateOne([stageDocument], {}, [stage])`. Before every stage, `original` and
`request` are cloned separately; after it succeeds, only a detached clone of
`stageDocument.request` becomes current. This preserves Mingo pipeline ordering
without allowing object references returned from `$original` to mutate the
snapshot or affect later conditions.

## Body Handling and Performance

Compiled transform metadata separately records whether conditions and updates
reference `request.body` or `original.body`.

- Header-only transforms do not read or clone the body stream.
- A body-referencing condition buffers and parses the body before matching.
- When conditions are body-independent, the runtime matches them first and
  parses the body only if a matched update needs it.
- Body-aware transforms require a JSON content type and parse the body at most
  once per Provider attempt.
- A modified body is serialized once with `JSON.stringify`.
- A body modification removes the previous `content-length` header so Fetch can
  calculate the correct length.
- Header-only updates preserve the original body object or stream.

This avoids paying JSON parse and serialization cost for Providers that only
need header manipulation. Network latency is expected to dominate ordinary LLM
requests, so native execution is deferred until an end-to-end benchmark proves
the JavaScript transform is material.

## Header Rules

Header names are validated using HTTP token syntax and normalized to lowercase.
The transform rejects modifications to connection-managed headers, including:

- `host`;
- `content-length`;
- `connection`;
- `transfer-encoding`;
- `keep-alive`;
- `upgrade`;
- `te`;
- `trailer`;
- proxy connection headers.

Authorization and Provider-specific authentication headers remain transformable
because the feature is explicitly Provider-scoped and Provider configuration is
already trusted to select the upstream base URL. Their values are nevertheless
redacted from diagnostics and are never copied into Dashboard previews or
validation errors.

After the pipeline completes, the runtime validates every resulting header name
and compares connection-managed headers with the pre-transform headers. An
unchanged forbidden header is allowed; a user rule that adds, removes, or
changes one is rejected. Removing `content-length` after a body rewrite is an
engine-owned operation and is allowed.

## Validation and Safety

Configuration validation has two layers:

1. Zod in `@aio-proxy/types` validates the public structure and JSON-safe values.
2. A semantic AST validator walks `when` and `update` to enforce the Mingo
   profile, operator arity, update target boundaries, header rules, and safe
   paths.

Every path rejects `__proto__`, `constructor`, and `prototype` segments. Mingo
runs with `scriptEnabled: false` and `failOnError: true`. Unknown or unsupported
operators are configuration errors rather than silently ignored operations.

The profile schema and semantic validator live in `@aio-proxy/types` so config
loading and the Dashboard share them without importing Mingo. The Dashboard
cannot save an AST that the server would later reject.

## Failure and Fallback

Transforms are atomic per Provider attempt. They operate on an isolated current
document and construct a new Request only after every matched rule succeeds.

Runtime failures include:

- a body-targeting rule receiving a non-JSON body;
- a type error in a computed expression;
- an invalid runtime value for a supported operator;
- request reconstruction failure.

Mingo and reconstruction errors are wrapped in a dedicated transform error
that exposes only the safe error code and rule/stage coordinates. The original
error message, cause, expression, and resolved operands are not forwarded to
the existing Provider-attempt logging path.

Any such failure:

1. sends no upstream request for the current Provider;
2. records a safe diagnostic containing Provider ID, optional rule name or rule
   index, update stage index, and an error code;
3. is treated as a Provider attempt exception;
4. falls back to the next candidate through the existing candidate loop.

Diagnostics do not include request header values, body values, prompt text, or
expression operands resolved from the request.

## Dashboard Editor

The Provider editor adds a Request Transforms section using the existing
Provider drawer and TanStack Form conventions.

### Condition editor

Use:

- `react-querybuilder`;
- the official React Query Builder shadcn registry source;
- `@react-querybuilder/expr` for field-to-field, arithmetic, and nested function
  expressions.

The registry components are copied into the Dashboard and adapted to its
existing Base UI-backed shadcn components. They must follow the Dashboard rule
of one React component per `.tsx` file.

`parseMongoDB()` loads the canonical `when` query into the visual builder.
`formatQuery(..., "mongodb_query")` writes it back. Expression-aware MongoDB
processors handle `$expr` round trips.

Model and header fields additionally offer a CPA-style Matches Pattern operator
where `*` matches zero or more characters. The serializer escapes every other
regex-significant character before generating `$regex`.

A separate Regex operator edits the raw pattern and the supported `i`, `m`,
`s`, and `u` flags. It maps directly to `$regex` plus `$options`, so a general
regex entered in JSON mode remains representable when switching to Visual mode
without being interpreted as a CPA wildcard pattern.

React Query Builder's built-in expression registry covers arithmetic, min/max,
absolute value, and case conversion. The Dashboard adds matching metadata,
Mongo serializers, and Mongo inverse mappings for the remaining allowed
functions: concatenate, condition, null fallback, concatenate arrays, and merge
objects.

### Update editor

The update editor is a reorderable list with two visual action types:

- Set header/body value;
- Remove header/body value.

Set switches between static value and computed expression. Computed values
reuse `ExpressionEditor` and `serializeMongoAgg()` from
`@react-querybuilder/expr`, with the static-literal escaping described above.
Every card maps one-to-one to a single-target `$set` or `$unset` stage.

### JSON mode

The existing Monaco `JsonEditor` edits the same canonical rule array with a
generated JSON Schema. Switching modes is lossless for the canonical profile:
one action per stage and the documented query shapes. Semantically equivalent
MongoDB spellings outside that canonical shape are rejected rather than
silently normalized. Invalid JSON or unsupported operators block saving and
display path-specific diagnostics.

The Dashboard dependencies are UI-only. Mingo does not need to be bundled into
the Dashboard unless a later local dry-run feature is approved.

## Dependencies and Distribution

- Add `mingo` to `@aio-proxy/server`, which owns the Fetch decorator and is the
  only package that executes transforms.
- Add `react-querybuilder`, `@react-querybuilder/core`, and
  `@react-querybuilder/expr` to the Dashboard. `@react-querybuilder/core` is a
  direct dependency because `parseMongoDB` is imported from its documented
  subpath.
- Copy the official MIT-licensed shadcn registry controls into the Dashboard and
  adapt them to local components instead of adding another UI framework.
- Do not add Node-API bindings, dynamic libraries, WASM, or Bun FFI.

The current single Ubuntu release job and four Bun cross-compiled CLI targets
remain unchanged.

## Future Response Transforms

The `transforms` namespace leaves room for a later `response` phase, but no
response config is accepted in this release.

A future design must separately define:

- upstream versus downstream response headers;
- non-streaming JSON response bodies;
- SSE/event-stream semantics;
- content encoding and decompression;
- usage capture and logging order.

Response-body support must not be inferred by simply buffering streams through
the request transformer.

## Verification

### Transform engine

- Query operators match and reject as specified.
- `$expr` compares fields and evaluates allowed functions.
- Rules match and update current sequentially; an earlier write can affect a
  later match and the last matching write wins.
- Conditions and expressions can explicitly read immutable original values.
- Copying an object from original and modifying it in a later stage does not
  mutate original.
- Matched rules and single-target stages preserve configuration order.
- Set and Remove cover body fields and headers, including header names with
  dots.
- Static strings beginning with `$` remain literals.
- Header-only rules do not consume the body.
- Body rules parse and serialize once and clear stale content length.
- Existing connection-managed headers survive when unchanged, while rule-owned
  changes to them are rejected.
- Script operators, unsupported stages, out-of-bound paths, and prototype paths
  are rejected.

### Server integration

- Raw API passthrough sends the transformed request.
- API-to-AI-SDK bridge sends the transformed request.
- Direct AI SDK Provider sends the transformed request.
- OAuth model traffic is transformed while OAuth auxiliary traffic is not.
- Observed upstream logging sees the transformed request.
- A transform exception sends nothing to that Provider and falls back to the
  next candidate.

### Dashboard

- Visual conditions round-trip through MongoDB query format.
- Field-to-field and nested expressions round-trip through `$expr`.
- Single-target Set and Remove stages round-trip between cards and JSON.
- CPA-style `*` model and header patterns round-trip through escaped `$regex`.
- General regex patterns and supported flags round-trip through the distinct
  Regex condition.
- Visual and JSON modes preserve the same canonical AST.
- Invalid or unsupported AST blocks save with a path-specific issue.

## Alternatives Considered

### JSON Logic plus RFC 6902

This provides portable condition and patch standards, but computed update values
require a custom extension and two different path/expression models. Mingo
handles query, cross-field expressions, and computed updates in one
zero-dependency JavaScript package.

### json-rules-engine

Its condition AST is visual-editor friendly, but events do not apply HTTP or
JSON mutations. aio-proxy would still need a second expression and update
system, so it does not reduce the product-specific layer.

### JSONata or jq

They can transform an entire document with one expression, but arbitrary
expressions cannot reliably round-trip through the required visual editor.

### GoRules Zen and Node-API

Zen supplies a strong native decision engine and visual decision graph tooling,
but its graph model is heavier than Provider request overrides. Native bindings
also complicate the current single-runner cross-compiled release pipeline.

### Bun FFI

Bun documents FFI as experimental and recommends Node-API for production. A
native implementation would only be compelling if raw JSON bytes stayed native
through parse, match, update, and serialization. That optimization is deferred
until benchmarks show the pure JavaScript path is a bottleneck.
