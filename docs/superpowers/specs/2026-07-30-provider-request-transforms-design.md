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
- Updates are ordered and may compute values from request or Provider context.
- Every condition evaluates against the original outbound request.
- Matched updates execute in configuration order against a mutable current
  request.
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
            - request.body.store
```

`transforms.request` is optional. Each rule has:

- `name?: string`: an optional diagnostic and UI label.
- `when?: object`: a restricted Mingo query. Omission means match every request.
- `update`: a non-empty ordered array of restricted Mingo update stages.

Rule array order is significant. No separate `enabled` field is needed in the
first release; removing a rule or an empty transform list disables it.

## Evaluation Documents

The runtime builds two related documents.

The match document is immutable and is used for every `when`:

```ts
{
  provider: {
    id: string,
    kind: string,
    protocol?: string,
  },
  request: {
    model: string,
    protocol?: string,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: JsonValue,
  },
}
```

The transform document is used for update expressions:

```ts
{
  provider: MatchDocument["provider"],
  original: MatchDocument["request"],
  request: MatchDocument["request"],
}
```

`original` never changes. `request` starts as a deep JSON-safe copy of
`original` and becomes the current request as matched rules execute.

The Provider ID and kind come from the materialized Provider. The model ID and
target protocol come from the attempt-scoped runtime context rather than being
guessed from a protocol-specific body. The existing attempt context already
carries Provider ID and model ID for outbound logging; it is extended with
target protocol metadata rather than introducing protocol branching into route
handlers.

Headers are represented with lowercase names. Repeated request header values
follow the Fetch `Headers` combined-value behavior. The body is present only
when it is a JSON payload that the transform needs to inspect or modify.

## Match Semantics

All rules are matched before any update is applied. Consequently:

- Reordering update stages changes the resulting request but not which rules
  match.
- A rule cannot make a later rule start or stop matching.
- The Dashboard can explain the complete matched rule set without simulating
  intermediate mutations.
- Update expressions may read the current value through `$request...` or the
  immutable value through `$original...`.

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

`$getField`, `$setField`, and `$unsetField` are reserved for generated header
operations so header names containing `.` or other Mongo path-significant
characters remain valid.

Static values and expressions are distinct in the visual editor. The serializer
uses `$literal` whenever a static string or object would otherwise be interpreted
as a field reference or operator expression.

### Update stages

Only `$set` and `$unset` pipeline stages are allowed.

- `$set` creates or replaces body fields and may use any allowed expression.
- `$unset` removes body fields and treats a missing path as a no-op.
- Header Set and Remove actions serialize as `$set` of the entire
  `request.headers` object using `$setField` or `$unsetField`.
- A `$set` targeting `request.headers` must be a validated `$setField` or
  `$unsetField` chain rooted at `$request.headers`; arbitrary replacement of the
  header object is rejected.
- Direct dot-path updates below `request.headers` are rejected so header names
  retain case-insensitive HTTP semantics and support literal dots.
- Update targets outside `request.body` and `request.headers` are rejected.
- Body update targets use Mongo dot-path semantics. Literal body keys containing
  `.` or beginning with `$` are outside the initial visual profile.
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

Each compiled `when` uses `Query.test()` against the immutable match document.
After all matches are known, each matched rule applies its stage array through
`updateOne([transformDocument], {}, stages)` and retains the resulting document
at index zero. The update condition is empty because rule matching has already
been completed against original.

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
and rejects forbidden connection-managed headers even if an allowed expression
computed the final header object dynamically.

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
The editor serializes only the allowed `$set` and `$unset` stages.

### JSON mode

The existing Monaco `JsonEditor` edits the same canonical rule array with a
generated JSON Schema. Switching modes is lossless because both modes accept
only the restricted, reversible profile. Invalid JSON or unsupported operators
block saving and display path-specific diagnostics.

The Dashboard dependencies are UI-only. Mingo does not need to be bundled into
the Dashboard unless a later local dry-run feature is approved.

## Dependencies and Distribution

- Add `mingo` to `@aio-proxy/server`, which owns the Fetch decorator and is the
  only package that executes transforms.
- Add `react-querybuilder` and `@react-querybuilder/expr` to the Dashboard.
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
- Every rule matches against original while updates read and modify current.
- Matched rules and stages preserve configuration order.
- Set and Remove cover body fields and headers, including header names with
  dots.
- Static strings beginning with `$` remain literals.
- Header-only rules do not consume the body.
- Body rules parse and serialize once and clear stale content length.
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
- Set and Remove stages round-trip between cards and JSON.
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
