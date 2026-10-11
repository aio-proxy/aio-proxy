# Responses request memory benchmark

## Incident and implementation

A client retried a 48,122,968-byte Responses request containing 29 inline images.
Its upload succeeded, but processing repeatedly exhausted a VPS with 929 MiB RAM
and 512 MiB swap. The OS killed the proxy, Nginx returned 502, and the client
retried. Adding 2 GiB swap allowed that request and the following request to
complete. This capacity mitigation exposed an opportunity to reduce the request
processing footprint itself.

Responses parsing previously read a cloned upload, collected its chunks, copied
them into a contiguous buffer, decoded the buffer, and parsed the JSON. Raw
forwarding repeated the read, decoding, and JSON parse before deciding whether
to rewrite the document. These phases could retain the original upload and
several large byte/string representations at the same time.

The optimization retains one wire document per inbound Request in a WeakMap.
Validation receives detached object/array containers while immutable strings are
shared. Raw rewriting reuses the original wire document; schema transformations
and mutations of parsed unknown fields cannot change it. The cache is reused
only for the same body limits and content encoding. Newly aborted, externally
locked, or consumed bodies are rejected. Bun clone/tee locks and already buffered reads on
pre-aborted signals retain their existing behavior. The container copy is
iterative so deeply nested unknown fields continue to work.

Uncompressed text reads now use a bounded stream and Bun's native Response text
reader, eliminating the explicit JavaScript chunk array plus contiguous buffer.
Compressed decoding retains its existing implementation. No-op forwarding still
uses original bytes, including compressed bytes and integers beyond JavaScript's
safe integer range. Provider replay and fallback remain supported.

## Method

- Baseline: upstream commit `e1102e01ceb62a3af25324c0640c9112263bece7`.
- Runtime: Bun 1.4.3 for both variants, fresh process for every sample.
- Synthetic fixture: 47,499,714 bytes, 29 inline image URLs in 100 paired custom
  tool calls/results. It contains no captured production data.
- Input is streamed in 64 KiB chunks. Each sample parses the request, prepares a
  raw provider request, drains it, then cancels the retained retry/ingress bodies.
- `rewrite` changes the model; `noop` leaves the model and wire document intact.
- Report medians, alternating baseline/optimized order: five samples per variant
  and scenario on Linux x64; seven on macOS arm64.
- Linux ran on the incident VPS in separate transient systemd units with
  `MemoryMax=650M`, `MemorySwapMax=1G`, and `Nice=10`. Production continued running.
- Peak RSS is the whole worker process's `process.resourceUsage().maxRSS` in KiB.
  Timings cover parse/rewrite/body drain, excluding module startup. CPU time
  includes worker startup. These are local proxy-path measurements; they do not
  measure model inference, Internet upload, or end-to-end API response latency.

## Results

| Platform / path | Baseline peak RSS | Optimized peak RSS | Reduction | Baseline time | Optimized time | Reduction |
| --------------- | ----------------: | -----------------: | --------: | ------------: | -------------: | --------: |
| Linux / rewrite |         517.5 MiB |          384.7 MiB |     25.7% |     940.88 ms |      635.61 ms |     32.4% |
| Linux / noop    |         380.6 MiB |          202.9 MiB |     46.7% |     504.43 ms |      357.09 ms |     29.2% |
| macOS / rewrite |         543.9 MiB |          385.8 MiB |     29.1% |      68.24 ms |       60.86 ms |     10.8% |
| macOS / noop    |         371.4 MiB |          203.8 MiB |     45.1% |      55.42 ms |       39.33 ms |     29.0% |

Linux worker CPU time decreased 30.2% for rewrite and 24.2% for noop. Results
depend on the allocator, upload chunking, host memory pressure, body composition,
and concurrency. The benchmark demonstrates a lower processing footprint; it
does not guarantee that a 1 GiB production deployment cannot run out of memory.

Raw sample results are in `responses-request-memory-results.json`.

## Reproduce

Build dependencies, then generate the fixture once:

```sh
bun install --frozen-lockfile
bunx turbo run build --filter=@aio-proxy/core
bun packages/core/scripts/benchmark-responses-request.ts --write-fixture /tmp/responses-48mb.json
bun build packages/core/scripts/benchmark-responses-request.ts --target=bun --outfile=/tmp/responses-worker.mjs
```

Run every sample in a separate process using the same Bun version:

```sh
bun /tmp/responses-worker.mjs /tmp/responses-48mb.json rewrite
bun /tmp/responses-worker.mjs /tmp/responses-48mb.json noop
```

For baseline comparison, copy the benchmark script into a separate checkout of
the baseline commit, build that checkout's dependencies, and bundle the script
there. Use the same fixture, runtime, host limits, and alternating sample order.
For compact requests, generate a separate fixture with the optional `compact`
argument to `--write-fixture`, then select the `compact` worker mode.

## Regression coverage

Tests cover unknown-field preservation despite parsed-object mutation, separate
inbound requests, changed byte budgets/content encoding, abort after parsing,
pre-aborted buffered requests, Request-to-Request cloning and replay, external
stream locks, consumed bodies, prototype-named JSON fields, deeply nested unknown fields, split UTF-8/BOM/malformed bytes,
and original no-op wire bytes. Pipeline tests carry 29 image tool results and
unknown fields through model rewriting, provider fallback, and encrypted-content
retry, for both plain and gzip uploads. Existing compact, compression, streaming,
upload-interruption, body-limit, and 65 MiB admission tests also apply.

## Acceptance and limitations

| Contract                                                | Verification                                                                                                                                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image/tool history and unknown fields survive rewriting | 29-image plain/gzip pipeline tests compare complete forwarded documents through failover and encrypted-content retry                                                                                            |
| Raw wire fidelity                                       | Existing create/compact no-op tests retain compressed bytes and unsafe-integer text; new reader tests retain original upload bytes                                                                              |
| Request admission                                       | Exact byte limits, one-byte overflow, encoded/decoded diagnostics, compressed expansion errors, and the existing 65 MiB admission regression                                                                    |
| Cancellation and cleanup                                | Actual TCP upload disconnect, stalled clone cancellation, retained-branch cancellation, post-parse abort with DOMException/string reasons, and pre-aborted buffered stream/non-stream server tests              |
| Schema isolation                                        | Nested object/array mutations, 6,000-level unknown nesting, prototype-named fields, changed limits/encoding and separate Request identities                                                                     |
| Provider/session/accounting behavior                    | Existing Guardian synthetic/original/retry/ordinary/failover accounting tests, raw response session ownership, retry and cross-protocol suites                                                                  |
| Build and integration                                   | Full repository preflight passed: 58/58 tasks; 8,752 tests passed, zero failed; eight existing Windows-only tests skipped on macOS. Type-aware lint, formatting, package builds and artifact smoke tests passed |

All final benchmark rows use the submitted implementation, including its native
`Response(body).text()` reader. The earlier exploratory timing figures were
superseded by this final run. Both variants share the same runtime and fixture.
Timing varies with concurrent production activity and host pressure; these are
sample medians, not a statistical confidence interval or an API latency SLA.

This change does not remove the retained upload/retry branches, JSON schema
validation, image strings, or serialization when rewriting is necessary. Many
simultaneous large requests can still exceed the VPS memory budget. Small
requests and upstream model/network performance have no quantified speedup in
this report. Compression behavior is regression-tested, but compressed-request
performance and sustained concurrent-load performance are not benchmarked here.

The production VPS remains on the existing formal release with its swap and
Nginx mitigations. This source change requires merge and a formal release before
production deployment and a separate post-deployment traffic acceptance check.
