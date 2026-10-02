---
description: 使用 @aio-proxy/plugin-openai-chatgpt 接入个人或组织 ChatGPT 订阅账号，调用前沿思考与多模态模型。
---

# OpenAI ChatGPT 插件

**插件包名**：`@aio-proxy/plugin-openai-chatgpt`  
**对应 Capability**：`default`

允许直接将个人或组织的 **ChatGPT Plus / Pro / Team / Enterprise** 账号接入 AIO Proxy，无需充值官方商业 API 额度，即可调用前沿大模型。

:::important{title="合规与使用限制提示"}
ChatGPT OAuth 授权通道**仅限个人开发或自用场景**，严禁将其部署用于多人共享服务、公共 API 转售或商业化转分发场景。请严格遵守 [OpenAI 服务条款 (Terms of Use)](https://openai.com/policies/terms-of-use/) 与使用政策，避免因异常多 IP 滥用或高并发并发调用触发官方账号风控与封禁。
:::

## 核心特性

- **动态获取上游模型**：运行时通过官方端点实时同步当前账号实际拥有的模型权限。不同账号订阅（Plus、Pro、Team、企业版）或灰度内测开放的模型均会自动保持最新，彻底杜绝静态硬编码造成的模型列表过时。
- **图片多模态生成**：内置支持 GPT Image 生成协议，包含 `gpt-image-2`、`gpt-image-2.5-sunburst` 与 `gpt-image-2.5-flare`。
- **配额监控**：实时追踪账号的用量消耗，并在触发频率上限前展示重置时间倒计时。

## 登录与授权

### 在 Dashboard 中授权

1. 进入 Dashboard -> **提供商** -> **添加提供商**。
2. 选择 **OAuth 账号** -> **OpenAI ChatGPT**。
3. 点击 **授权登录**，在弹出的 OpenAI 登录页中确认授权。

### 命令行登录

```sh
aio-proxy provider login chatgpt
```

### 复用本机上的 Codex 登录

如果已在 Codex 中登录，可在 Dashboard 的浏览器授权按钮旁选择 **使用本机上的 Codex 登录**。只有在运行服务器的机器上检测到登录时才显示此选项。没有该登录的容器或无头服务器不会显示；在浏览器所在机器上登录，不会向远程服务器提供登录。

也可以在 `aio-proxy provider login` 的交互提示中选择本机登录，或运行：

```sh
aio-proxy provider login --local-sign-in
```

按提示选择 OpenAI ChatGPT。只有明确选择使用本机登录后，aio-proxy 才会读取 `$CODEX_HOME/auth.json`（默认为 `~/.codex/auth.json`）。Codex 配置为 `cli_auth_credentials_store = "keyring"` 时没有登录文件，因此不会显示此选项。

aio-proxy 刷新关联账号时会将轮换后的令牌写回，让 Codex 保持登录。Provider 会显示 **已关联本机上的 Codex 登录** 徽标。移除 Provider 永远不会使 Codex 退出登录，也不会改变其登录文件。

#### 恢复关联的 Provider

- Provider 已禁用但 Codex 仍可用：在该 Provider 上再次使用本机登录。
- 两边都已退出登录：先在 Codex 中重新登录，再在该 Provider 上使用本机登录。
- Codex 切换到了其他账号：切回原账号，或为该账号添加新的 Provider。

## 配置示例

```jsonc title="config.jsonc"
{
  "providers": {
    "chatgpt-pro": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-openai-chatgpt",
      "capability": "default",
      "priority": 20,
      "weight": 100,
      "alias": {
        "gpt-5": "gpt-5",
      },
    },
  },
}
```
