---
description: Export distributed traces and metrics to OpenTelemetry collectors and observability platforms.
---

# OpenTelemetry Export

AIO Proxy supports standard OTLP (OpenTelemetry Protocol) exports, allowing you to ship traces and metrics directly to central observability backends.

## Configuration

Add the `telemetry` block to your `config.jsonc`:

```jsonc title="config.jsonc"
{
  "telemetry": {
    "traces": {
      "exporter": "otlp-http", // or otlp-grpc
      "endpoint": "http://otel-collector:4318/v1/traces",
      "headers": {
        "Authorization": "Bearer {{env.OTEL_AUTH_TOKEN}}",
      },
    },
  },
}
```

---

## Supported Observability Platforms

AIO Proxy traces conform to the GenAI Semantic Conventions and can be visualized in:

- **Cloudflare AI Gateway**
- **Datadog**
- **Dynatrace**
- **Honeycomb**
- **Grafana Tempo / Loki**
- **Langfuse / Arize Phoenix**
