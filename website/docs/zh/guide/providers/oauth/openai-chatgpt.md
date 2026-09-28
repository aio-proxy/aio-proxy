---
description: 使用 @aio-proxy/plugin-openai-chatgpt 接入个人或组织 ChatGPT 订阅账号，调用前沿思考与多模态模型。
---

# OpenAI ChatGPT 插件

**插件包名**：`@aio-proxy/plugin-openai-chatgpt`  
**对应 Capability**：`chatgpt`

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

## 配置示例

```jsonc title="config.jsonc"
{
  "providers": {
    "chatgpt-pro": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-openai-chatgpt",
      "capability": "chatgpt",
      "priority": 20,
      "weight": 100,
      "alias": {
        "gpt-5": "gpt-5",
      },
    },
  },
}
```
