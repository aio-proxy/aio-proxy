---
description: 使用 aio-proxy agent configure claude-code 接入 Anthropic Claude Code，将代理地址与 Token 合并写入全局 settings.json。
---

# Anthropic Claude Code 接入

Claude Code 从全局 `settings.json` 的 `env` 块读取接口地址和凭据。AIO Proxy 只写入它需要的两个键，文件的其余内容保持不变。

## 一键配置

```sh
aio-proxy agent configure claude-code
```

该命令会把两个键合并进 `~/.claude/settings.json`（或 `CLAUDE_CONFIG_DIR` 指定的目录）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9317",
    "ANTHROPIC_AUTH_TOKEN": "aio-proxy-local"
  }
}
```

配置后请重启 Claude Code。你的其他设置和 `env` 条目不会被修改，项目级的 `.claude/settings.json` 也不会被触碰。

---

## 写入哪个 Token

只写 Base URL 是不够的：没有凭据变量时，Claude Code 会继续使用已保存的 claude.ai 登录。写入的 Token 取决于代理的 `server.apiKeys`：

- **未配置 API Key（默认）**：写入非秘密的占位值 `aio-proxy-local`，无需任何选择。
- **已配置 API Key**：由你在终端或 Dashboard 的 **Agents** 页面选择一把已有的 Key。它会先经代理校验，再以明文写入，同时 `settings.json` 的权限会收紧为仅当前用户可读写（`0600`）；请不要把它同步到共享的 dotfiles。AIO Proxy 不会替你选择 Key；非交互环境下命令会直接失败，不写入任何内容。

:::tip
如果轮换或删除了所选的 Key，请重新运行 `aio-proxy agent configure claude-code` 选择新的 Key。
:::

---

## 检查与解除

```sh
aio-proxy agent list --check
```

Claude Code 会显示为 `managed`；如果你自行修改过受管字段，则显示 `modified` 并列出这些字段。`--check` 还会用已配置的 Token 探测代理。

```sh
aio-proxy agent remove claude-code
```

解除操作可以离线执行。两个键会恢复为配置之前的值；你在配置之后修改过的键会被保留并在结果中列出。代理的 API Key 不会被删除。

AIO Proxy 把写入记录保存在 `~/.claude/.aio-proxy/claude-code-config.json`，位于 Claude Code 会重写的文件之外，因此在你修改 `/config` 选项之后，集成状态依然可以识别。如果你修改过受管的键，`configure` 会拒绝覆盖，请先执行 `remove`。
