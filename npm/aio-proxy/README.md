# aio-proxy

All-in-one LLM API proxy with a local dashboard.

## Install

- npm: `npm install -g aio-proxy`
- curl: `curl -fsSL https://raw.githubusercontent.com/baranwang/aio-proxy/main/install.sh | sh`

Then run `aio-proxy serve`.

## Security model

aio-proxy currently trusts the local machine and only accepts `127.0.0.1`, `::1`, or `localhost` as its server
host. Remote binding is deliberately rejected until an authenticated remote mode is designed.

## Network configuration

Only HTTP(S) proxy URLs are supported. A provider `proxy` inherits the top-level value when omitted, overrides it
with a string, or disables it with `false`. API `headers` are applied last on raw and bridged upstream calls.
`{{env.NAME}}` templates are one-pass environment substitutions on configuration string leaves (provider `kind` and
object keys are not templatable); missing values become empty strings before validation. Built-in AI SDK packages
guarantee injected proxy fetch support; third-party dynamic packages are best effort.

```yaml
proxy: "{{env.GLOBAL_PROXY}}"

providers:
  openai:
    kind: api
    protocol: openai-response
    baseURL: https://api.openai.com/v1
    apiKey: $OPENAI_API_KEY
    proxy: false
    headers:
      Authorization: "Bearer {{env.OPENAI_UPSTREAM_TOKEN}}"
      X-Tenant: "{{env.TENANT_ID}}"

  anthropic-sdk:
    kind: ai-sdk
    packageName: "@ai-sdk/anthropic"
    proxy: "{{env.ANTHROPIC_PROXY}}"
    options:
      apiKey: "{{env.ANTHROPIC_API_KEY}}"
```
