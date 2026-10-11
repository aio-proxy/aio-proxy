---
description: Connect OpenAI ChatGPT Pro / Team accounts to AIO Proxy with dynamic model discovery and automatic token renewal.
---

# OpenAI ChatGPT OAuth

Connect your personal OpenAI ChatGPT subscription account to AIO Proxy.

:::important{title="Compliance & Usage Restrictions"}
The ChatGPT OAuth integration is intended strictly for personal development and debugging purposes. Do not use this integration to redistribute access, proxy traffic for multiple users, or violate OpenAI Terms of Service.
:::

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "my-chatgpt": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-openai-chatgpt",
      "capability": "default",
    },
  },
}
```

## Login

```sh
aio-proxy provider login
```

Select OpenAI ChatGPT, then follow the browser prompt to complete OpenAI authentication. AIO Proxy will automatically fetch the latest accessible models (such as `gpt-5`, `o3-mini`, and code-specialized variants) dynamically from upstream.

## Reuse the Codex sign-in on this machine

If you already signed in to Codex, choose **Use the Codex sign-in on this machine** beside the browser authorize button in the Dashboard. The option appears only when a sign-in is detected on the machine running the server. Containers and headless servers without that sign-in show no option; signing in on the machine running your browser does not supply a sign-in to a remote server.

You can also select the local sign-in in the interactive `aio-proxy provider login` prompt, or run:

```sh
aio-proxy provider login --local-sign-in
```

Select OpenAI ChatGPT when prompted. Only after you choose to use the local sign-in does aio-proxy read `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`). Codex configured with `cli_auth_credentials_store = "keyring"` has no sign-in file, so this option does not appear.

When aio-proxy refreshes the linked account, it writes rotated tokens back to keep Codex signed in. The Provider shows a **Linked to Codex on this machine** badge. Removing the Provider never signs Codex out or changes its sign-in file.

### Recover a linked Provider

- If the Provider is disabled while Codex still works, use the local sign-in again on that Provider.
- If both are signed out, sign in again in Codex, then use the local sign-in again on the Provider.
- If Codex is on a different account, switch it back or add a new Provider for that account.
