---
description: Learn the file locations, JSONC schema, environment variable templates, and CLI editing tools for AIO Proxy configuration.
---

# Configuration Files & Env

AIO Proxy uses JSONC (JSON with comments) as its core configuration format.

## File Locations & Search Precedence

The default configuration file is located at:

- **macOS / Linux**: `~/.aio-proxy/config.jsonc`

You can customize the location using the `--config` flag or the `AIO_PROXY_CONFIG` environment variable:

```sh
# Start with custom config path
aio-proxy run --config /opt/stacks/aiop/config.jsonc
```

---

## JSON Schema Validation

Add the `$schema` header at the top of your `config.jsonc` to enable real-time auto-completion, field validation, and documentation in VS Code, Cursor, and modern editors:

```jsonc
{
  "$schema": "https://unpkg.com/@aio-proxy/types/config.schema.json",
  "providers": {
    // ...
  },
}
```

---

## Environment Variable Templating

Never hardcode plain-text API keys or secrets in your configuration files. AIO Proxy supports template interpolation syntax:

- `{{env.VARIABLE_NAME}}`: Reads the specified environment variable at runtime.
- `{{env.VARIABLE_NAME:-default_value}}`: Provides a default fallback value if the environment variable is not defined.

```jsonc title="config.jsonc"
{
  "providers": {
    "my-openai": {
      "kind": "api",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "baseURL": "{{env.OPENAI_BASE_URL:-https://api.openai.com/v1}}",
      "models": ["gpt-5"],
    },
  },
}
```

---

## CLI Configuration Management

AIO Proxy CLI provides built-in utilities for inspecting and maintaining configuration files:

```sh
# Open configuration in your system default editor
aio-proxy config edit

# Validate syntax, JSON schema constraints, and environment variables
aio-proxy config validate

# Print currently resolved active configuration (secrets masked by default)
aio-proxy config print

# Print with unmasked secrets (useful for container debugging)
aio-proxy config print --reveal-secrets

# Signal the running server to hot-reload without restarting
aio-proxy reload
```
