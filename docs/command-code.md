# Command Code

Connect [Command Code's Provider API](https://commandcode.ai/docs/provider) to AIO Proxy with an API Provider. Create an API key in Command Code Studio and make it available as `CMD_API_KEY` to the process running AIO Proxy.

Command Code documents API access for GOAT, Pro, Max, Team, and Provider plans. Coding subscriptions charge API requests against their plan credits and model allowances; the Go plan does not include API access. Check the current [plan documentation](https://commandcode.ai/docs/resources/pricing-limits) for your account's limits.

## Configuration

Merge the relevant entries below into your configuration's `providers` object. Choose models your plan allows from the [live catalog](https://api.commandcode.ai/provider/v1/models).

```jsonc
{
  "providers": {
    "command-code": {
      "kind": "api",
      "apiKey": "{{env.CMD_API_KEY}}",
      "models": ["deepseek/deepseek-v4-flash"],
      "endpoints": {
        "baseURL": "https://api.commandcode.ai/provider/v1",
        "protocol": ["openai-compatible"],
      },
    },
    "command-code-claude": {
      "kind": "api",
      "apiKey": "{{env.CMD_API_KEY}}",
      "models": ["claude-sonnet-4-6"],
      "endpoints": [
        {
          "baseURL": "https://api.commandcode.ai/provider/v1",
          "protocol": "anthropic",
          "auth": "bearer",
        },
      ],
    },
  },
}
```

The separate Provider entries are intentional: Command Code accepts Claude models at `/provider/v1/messages` and other models at `/provider/v1/chat/completions`. Advertising both protocols for the same model would allow a same-protocol request to reach the wrong upstream endpoint. Separate model lists let AIO Proxy select the appropriate Provider and convert the client's protocol when needed.

Use `endpoints` to retain `/provider/v1`. A legacy top-level `protocol`/`baseURL` pair uses only the URL's origin for same-protocol passthrough and would send these requests to the wrong path.

Validate and reload after saving:

```sh
aio-proxy config validate
aio-proxy reload
```

Point your client at AIO Proxy's local endpoint, normally `http://127.0.0.1:9317/v1`, and select one of the configured model IDs. If AIO Proxy requires a caller API key, configure that key in the client; `CMD_API_KEY` is the upstream credential used by the proxy.

## Dashboard

Create an **API** Provider, select **OpenAI Compatible**, and enter `https://api.commandcode.ai/provider/v1` as its address. Enter your Command Code API key and add the non-Claude models you want to expose.

For Claude, create a separate **API** Provider with **Anthropic** and the same address. The default `x-api-key` authentication is supported by Command Code; the independent-address editor also allows selecting **Bearer** to match the file example above. Add only the Claude models to this Provider.

New single-protocol entries preserve the full address. An existing legacy `protocol`/`baseURL` configuration keeps its historical behavior; use the `endpoints` configuration above to migrate one that needs the `/provider/v1` prefix.

## Troubleshooting

- **404 or a missing `/provider` prefix:** check that the saved Provider uses `endpoints` and the complete address above.
- **400 `invalid_request_error`:** check the model's protocol and its Provider's model list.
- **401:** check the API key supplied to AIO Proxy and the upstream key configured for the Provider.
- **403 `upgrade_required`:** the official API is unavailable on the Go plan.

See Command Code's [API reference](https://commandcode.ai/docs/provider#errors) for current upstream errors and account requirements.
