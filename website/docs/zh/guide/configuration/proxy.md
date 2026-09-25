---
description: AIO Proxy 的正向网络代理配置：HTTP(S)、SOCKS5 协议支持、提供商独立代理覆盖与主备代理热切容灾机制。
---

# 代理与主备容灾

在访问 OpenAI、Anthropic 等受地域限制的国际模型提供商时，通常需要借助网络代理。AIO Proxy 内置了强大的正向代理管理与主备容灾能力。

## 全局默认代理 (`proxy`)

在配置顶级配置 `proxy`，所有未显式设置代理的提供商将自动继承该配置：

```jsonc title="config.jsonc"
{
  // 支持 HTTP(S) 与 SOCKS5
  "proxy": "socks5://127.0.0.1:1080",
  "providers": {
    // 该提供商继承全局代理
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

### 代理协议支持

AIO Proxy 原生支持以下 URL 协议头：

- `http://` 或 `https://`：标准 HTTP/HTTPS 代理（要求代理服务器支持 HTTP CONNECT 隧道方法）。
- `socks://`、`socks5://`、`socks5h://`：SOCKS5 代理协议。

**带认证的代理格式：**

如果代理需要用户名与密码认证，可直接编码在 URL 中：

```text
socks5://username:password@127.0.0.1:1080
http://user:pass@proxy.example.com:8080
```

## 提供商独立代理定制

每个提供商都可以独立设置网络代理策略，完全覆盖全局设置：

```jsonc title="config.jsonc"
{
  "proxy": "http://127.0.0.1:7890",
  "providers": {
    // 1. 直连：显式设为 false，完全禁用代理
    "deepseek": {
      "kind": "api",
      "baseURL": "https://api.deepseek.com",
      "apiKey": "{{env.DEEPSEEK_API_KEY}}",
      "models": ["deepseek-chat"],
      "proxy": false,
    },
    // 2. 独立代理：指定专用代理节点
    "anthropic": {
      "kind": "api",
      "baseURL": "https://api.anthropic.com/v1",
      "apiKey": "{{env.ANTHROPIC_API_KEY}}",
      "models": ["claude-sonnet-4-6"],
      "proxy": "socks5://us-node.proxy.internal:1080",
    },
  },
}
```

## 主备双代理热切容灾 (`proxyFallback`)

网络代理节点出现波动或断线是日常开发中常见的痛点。AIO Proxy 支持**主备代理热切 (Proxy Fallback)** 机制：

```jsonc title="config.jsonc"
{
  "proxy": "http://primary-proxy.internal:8080",
  "proxyBackup": "socks5://backup-proxy.internal:1080",
  "proxyFallback": true,
}
```

### 容灾切换逻辑与安全保证

1. **建连超时探测**：发起网络请求时，首先尝试主代理。若主代理建连失败或在 **5 秒内**无法完成握手，系统将自动使用备用代理 (`proxyBackup`) 重新建连。
2. **幂等性与非破坏性**：只有在**TCP 建连/握手阶段失败**时才会触发切换；一旦请求报文已经发出、或者上游已经开始返回 HTTP 业务错误（如 400/404/500 等），AIO Proxy 绝不会重复重发请求，防止产生非幂等性的重复扣费或重复扣款。
3. **独立覆盖**：Provider 如果配置了自己的 `proxy`、`proxyBackup` 和 `proxyFallback`，将完全覆盖全局主备策略，且自己的 fallback 关闭时绝不回退至全局代理。
