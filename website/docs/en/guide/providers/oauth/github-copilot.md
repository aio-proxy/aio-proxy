---
description: Connect GitHub Copilot and Copilot Business/Enterprise accounts via Device Flow.
---

# GitHub Copilot OAuth

Connect GitHub Copilot using standard OAuth Device Flow.

## Configuration

```jsonc title="config.jsonc"
{
  "providers": {
    "my-copilot": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-github-copilot",
      "capability": "default",
    },
  },
}
```

## Login

```sh
aio-proxy provider login
```

Select GitHub Copilot and follow the device-code authorization prompt in your browser.

## Reuse the GitHub Copilot sign-in on this machine

If you already signed in to GitHub Copilot, choose **Use the GitHub Copilot sign-in on this machine** beside the browser authorize button in the Dashboard. The option appears only when a sign-in is detected on the machine running the server. Containers and headless servers without that sign-in show no option; signing in on the machine running your browser does not supply a sign-in to a remote server.

You can also select the local sign-in in the interactive `aio-proxy provider login` prompt, or run:

```sh
aio-proxy provider login --local-sign-in
```

Select GitHub Copilot and complete its account options when prompted. Only after you choose to use the local sign-in does aio-proxy read `~/.config/github-copilot/apps.json` or the older `hosts.json`, honoring `$XDG_CONFIG_HOME` when set. It reads the sign-in once at link time; the stored GitHub token does not rotate.

The Provider shows a **Linked to GitHub Copilot on this machine** badge. Removing the Provider never signs GitHub Copilot out or changes its sign-in files.

### Recover a linked Provider

- If the Provider is disabled while GitHub Copilot still works, use the local sign-in again on that Provider.
- If both are signed out, sign in again in GitHub Copilot, then use the local sign-in again on the Provider.
- If GitHub Copilot is on a different account, switch it back or add a new Provider for that account.
