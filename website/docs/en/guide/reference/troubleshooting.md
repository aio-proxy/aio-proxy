---
description: Common issues, connection errors, port conflicts, and resolution steps.
---

# FAQ & Troubleshooting

Solutions and diagnostic steps for frequent operational issues.

---

## 1. Port 9317 Already in Use

### Symptom

Startup fails with `EADDRINUSE: address already in use 127.0.0.1:9317`.

### Resolution

1. Check if another instance or background service is already running:
   ```sh
   lsof -iTCP:9317 -sTCP:LISTEN
   ```
2. If running as a service, manage via `aio-proxy service status`.
3. To terminate a stale process:
   ```sh
   kill -15 <PID>
   ```

---

## 2. Docker Container Inaccessible from Host

### Symptom

Container starts successfully, but `curl http://localhost:9317/v1/models` returns `Connection refused`.

### Resolution

Ensure the container startup command specifies `--host 0.0.0.0`. By default, the server binds to `127.0.0.1` inside the container namespace, preventing port forwarding from the host.

---

## 3. Upstream 502 / Connection Timeout

### Symptom

Requests fail with `502 Bad Gateway` or `upstream connection timeout`.

### Resolution

1. Check outbound proxy settings under `proxy` in `config.jsonc`.
2. Inspect the request in the Dashboard's **Traces** page to view the exact error returned by the upstream provider.
3. Use the **Test** probe button on the provider card to verify connectivity.
