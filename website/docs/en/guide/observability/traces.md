---
description: Detailed request tracing, TTFT benchmarks, failover step diagnostics, and error inspection.
---

# Request Traces & Diagnostics

Every request routed through AIO Proxy generates an end-to-end trace span stored in the local SQLite database (`state.db`).

## Trace Details

- **Request Identifiers**: Unique trace IDs and inbound client headers.
- **Failover Chain**: When multiple candidates are attempted, each step records timestamps, candidate names, HTTP status codes, and error diagnostics.
- **Performance Metrics**:
  - **TTFT (Time to First Token)**: First chunk response time for streaming requests.
  - **Total Latency**: Full request-response roundtrip time.
- **Token Breakdown**: Prompt tokens, completion tokens, reasoning tokens, and cached tokens.
