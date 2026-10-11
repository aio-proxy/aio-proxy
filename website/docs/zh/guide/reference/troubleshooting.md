---
description: AIO Proxy 常见使用故障排查：端口占用、429 限流机制、超时排查、OAuth 凭据刷新与多模态降级。
---

# 常见问题与排查

## 1. 端口 9317 被占用或服务启动失败

**现象**：启动时报错 `EADDRINUSE: address already in use 127.0.0.1:9317`。

**排查步骤**：

1. 检查是否已有其他后台 AIO Proxy 进程在运行：
   ```sh
   aio-proxy status
   ```
2. 检查系统中占用 9317 端口的进程：
   ```sh
   # macOS / Linux
   lsof -iTCP:9317 -sTCP:LISTEN
   ```
3. 若确认是非法残留进程，可终止该进程或指定备用端口启动：
   ```sh
   aio-proxy run --port 9318
   ```

---

## 2. 上游返回 429 Too Many Requests 与自动熔断冷却

**机制**：

- 当某个 Provider 收到上游返回的 429 报错时，AIO Proxy 会自动将该请求**立即故障回退 (Failover)** 至同一优先级或下一优先级的备选 Provider。
- 同时，该触发 429 的 Provider 会进入一段冷却观察期（尊重上游的 `Retry-After`，并受 `server.retry.retryAfterCapMs` 保护上限）。
- 冷却期间，新请求会自动跳过该 Provider，优先发往其他健康的 Provider，避免持续产生无效的 429 错误。

**排查建议**：

- 在 Dashboard 的提供商列表中查看该 Provider 是否处于冷却标记。
- 在“用量”页面查看订阅账号的重置窗口倒计时。
- 为核心模型配置备用提供商（不同 Priority 层级），保障高可用。

---

## 3. 网络请求超时 (Timeout)

**现象**：请求耗时极长最终报错 `Gateway Timeout` 或 `Fetch Failed`。

**排查步骤**：

1. **检查代理配置**：
   - 若配置了 `proxy`，在终端测试代理节点连通性：
     ```sh
     curl -x socks5://127.0.0.1:1080 -I https://api.openai.com
     ```
   - 开启主备代理容灾：配置 `proxyBackup` 并开启 `proxyFallback: true`，当主代理 5 秒握手失败时自动切换。
2. **执行全面体检**：
   ```sh
   aio-proxy doctor
   ```

---

## 4. OAuth 账号凭据失效或 401 Unauthorized

**排查建议**：

1. 打开 Dashboard 的“提供商”页面，点击对应 OAuth 卡片上的“测试”探针。
2. 若提示凭据已失效或刷新令牌被官方作废，直接在卡片上点击“重新授权”重新扫码或登录即可。
3. 若使用的是 Grok Build，可重新在终端执行 `grok login` 触发本地授权更新。

---

## 5. 跨协议调用中的工具调用与思考过程解析

**现象**：某些客户端在通过跨协议转换（例如将 OpenAI 请求转为 Claude）时，未收到预期的思考内容。

**排查建议**：

- 对于开源深度思考模型（如 DeepSeek-R1），如果是通过 `ai-sdk` 接入，请确保在提供商配置中开启了 `"parseReasoningContent": true`。
- 检查客户端使用的协议：AIO Proxy 已经为 OpenAI Chat Completions、Responses、Anthropic Messages 和 Gemini 实现了完备的双向工具转码，但在使用某些特殊专有格式时，推荐通过 `endpoints` 使用原生透传模式。

## 6. 大图片历史或手动压缩请求返回 413

默认普通请求上限为 256 MiB；可通过 `server.requestBody.maxBytes` 设置 1..512 MiB 的整数容量，热更新只影响新请求。压缩请求同时检查传输体与解压体，媒体专用限制仍单独生效。日志的 `bodyLimitStage`、`bodyLimitBytes`、`bodyMeasurement` 及已知的 `bodyBytes` 可区分本地 encoded/decoded 拒绝；`observed_lower_bound` 是已观察下界，不是完整 wire 大小。

含图片的历史 JSON 文件大小或 token 数不能代替实际 HTTP 请求字节测量。正文日志有独立的 `server.logging.captureMaxBytes`（默认 64 MiB），日志截断不会截断转发；敏感或无法检查的正文不会落盘。提高接收容量后仍应留意 JSON、Base64 和克隆带来的数倍内存占用，并实际验证上游是否接受。正式版本升级后的原会话手动压缩成功需要运行环境验收，不能仅由本地测试推断。
