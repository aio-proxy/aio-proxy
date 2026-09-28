---
description: Configure outbound HTTP/HTTPS proxies, socks5 tunnels, SSL validation, connection pooling, and circuit breaker timeouts.
---

# Proxy & High Availability (`proxy`)

The `proxy` block sets global outbound networking policies, including proxy chains, connection limits, and error timeouts.

```jsonc title="config.jsonc"
{
  "proxy": {
    "url": "http://127.0.0.1:7890",
    "noProxy": ["localhost", "127.0.0.1", "*.internal.net"],
    "timeoutMs": 60000,
    "maxRetries": 3,
    "circuitBreaker": {
      "failureThreshold": 5,
      "resetTimeoutMs": 30000,
    },
  },
}
```

## Key Configuration Fields

- **`url`**: Outbound HTTP/HTTPS or SOCKS5 proxy URL for reaching upstream model services.
- **`noProxy`**: Hostnames or CIDR domains that bypass the proxy.
- **`timeoutMs`**: Maximum request timeout in milliseconds before triggering a failover.
- **`maxRetries`**: Maximum number of failover attempts across available candidates for a single request.
- **`circuitBreaker`**: Circuit breaker parameters. When an upstream provider accumulates consecutive network failures exceeding `failureThreshold`, it is temporarily cooled down for `resetTimeoutMs` before re-probing.
