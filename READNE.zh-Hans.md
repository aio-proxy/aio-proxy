# AIO Proxy

[English](./README.md) | 简体中文

用一个 API 入口接入和管理多个模型提供商。AIO Proxy 提供可扩展的插件系统、自动路由与故障回退，以及覆盖用量、费用和请求链路的可观测性。

```mermaid
flowchart LR
  subgraph Clients["多种客户端"]
    OpenAIClient["OpenAI 兼容客户端"]
    AnthropicClient["Anthropic 客户端"]
    GeminiClient["Gemini 客户端"]
  end

  Proxy["AIO Proxy<br/>协议转换 · 智能路由<br/>插件扩展 · 可观测性"]

  subgraph Providers["模型提供商"]
    OpenAI["OpenAI"]
    Anthropic["Anthropic"]
    Google["Google"]
    PluginProviders["其他插件 Provider"]
  end

  OpenAIClient --> Proxy
  AnthropicClient --> Proxy
  GeminiClient --> Proxy

  Proxy --> OpenAI
  Proxy --> Anthropic
  Proxy --> Google
  Proxy --> PluginProviders
```

## 核心能力

- **插件化接入**：通过插件连接不同模型提供商，支持 AI SDK Provider 包和 OAuth 账号。
- **丰富可观测性**：集中查看请求量、Token 用量、费用和完整请求链路。
- **主流协议兼容**：支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini GenerateContent。
- **多 Provider 路由**：按模型和 Provider weight 选择候选，支持模型别名、故障回退和会话亲和。
- **透明协议转换**：协议一致时原始透传，协议不一致时自动转换。

## 安装

### Homebrew

```bash
brew install aio-proxy/tap/aio-proxy
```

### Bun

```bash
bun add -g aio-proxy
```

## 快速开始

```bash
aio-proxy run --open
```

- API：`http://127.0.0.1:9317`
- Dashboard：`http://127.0.0.1:9317/dashboard`

首次运行会创建 `~/.aio-proxy/config.jsonc`。初始配置不包含 Provider，可以通过 Dashboard 添加，也可以直接编辑配置文件：

```bash
aio-proxy config path
aio-proxy config edit
```

## 配置

下面的示例将 `gpt-5` 路由到 OpenAI Responses API：

```jsonc
{
  "$schema": "https://cdn.jsdelivr.net/npm/aio-proxy@latest/config.schema.json",
  "providers": {
    "openai": {
      "kind": "api",
      "protocol": "openai-response",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "models": ["gpt-5"],
    },
  },
}
```

验证或重新加载配置：

```bash
aio-proxy config validate
aio-proxy reload
```

支持 `$schema` 的编辑器可以为配置提供补全和校验。`{{env.NAME}}` 用于读取环境变量。

## 路由规则

`providers` 对象中的键是稳定的 **Provider ID**。一次请求按以下规则处理：

1. 找出所有提供请求模型或对应别名的 Provider。
2. 按 Provider weight 从高到低尝试；相同或未设置的 Provider weight 保持配置顺序。
3. 活动会话优先使用此前成功的 Provider，以保持会话连续性。
4. 同协议的 `api` Provider 使用原始透传，其他组合通过 AI SDK 转换。
5. 当前 Provider 失败后尝试下一个候选；全部失败时返回最后一次失败。

## API

| 协议或用途               | 方法与路径                                          |
| ------------------------ | --------------------------------------------------- |
| 健康检查                 | `GET /health`                                       |
| 模型列表                 | `GET /v1/models`                                    |
| OpenAI Chat Completions  | `POST /v1/chat/completions`                         |
| OpenAI Responses         | `POST /v1/responses`                                |
| Anthropic Messages       | `POST /v1/messages`                                 |
| Anthropic Token Counting | `POST /v1/messages/count_tokens`                    |
| Gemini                   | `POST /v1beta/models/{model}:generateContent`       |
| Gemini 流式生成          | `POST /v1beta/models/{model}:streamGenerateContent` |
| Gemini Token Counting    | `POST /v1beta/models/{model}:countTokens`           |

调用 OpenAI Responses 入口：

```bash
curl http://127.0.0.1:9317/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5","input":"用一句话介绍 AIO Proxy。"}'
```

## Dashboard 与可观测性

Dashboard 默认位于 `http://127.0.0.1:9317/dashboard`，用于管理 Provider 并提供运行可观测性：

- 添加、编辑和测试 Provider，包括插件 OAuth 登录。
- 查看请求量、Token 用量和费用趋势。
- 搜索完整请求链路，检查每次 Provider 尝试的状态与耗时。

可以通过 `server.password` 设置 Dashboard 密码。该密码只保护 Dashboard，不保护模型 API。

## 网络与安全

顶层 `proxy` 可以配置默认 HTTP(S) 代理；Provider 可以继承、覆盖或通过 `false` 禁用它。`api` Provider 还可以通过 `headers` 设置上游请求头。

AIO Proxy 进程目前只允许绑定到 `127.0.0.1`、`::1` 或 `localhost`，但可以运行在个人电脑、远程服务器或容器中。需要远程访问时，可以通过反向代理、隧道或网关暴露服务，并在外层配置 TLS、身份认证和访问控制。

## 常用命令

```bash
aio-proxy status --deep
aio-proxy provider list --probe
aio-proxy doctor
aio-proxy --help
```

## 贡献

开发环境和提交流程请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)
