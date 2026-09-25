---
description: 使用 aio-proxy agent configure codex 交互式配置 OpenAI Codex CLI / Desktop，支持会话迁移与免贴 Token 安全桥接。
---

# OpenAI Codex 接入

OpenAI Codex 拥有强大的代码生成与智能协同能力。AIO Proxy 提供了针对 Codex 的原生配置向导，能够自动检测 Codex 环境并完成提供商注入与历史会话平滑过渡。

## 一键配置

确保 AIO Proxy 服务正在运行，然后在终端执行：

```sh
aio-proxy agent configure codex
```

### 向导交互流程

命令会启动交互式终端向导，引导完成以下设置：

1. **设置 Provider ID**：
   - 默认为 `aio-proxy`。如果你在 Codex 中已有同名提供商，可自定义未被占用的名称。
2. **选择认证模式 (Auth Mode)**：
   - **保持 ChatGPT 登录 (`keep-chatgpt`)**：保留 Codex 原生的官方 ChatGPT 登录状态，同时将自定义提供商指向 AIO Proxy。
   - **命令行助手鉴权 (`command`)**：使用 AIO Proxy 注册的本地 Auth Helper (`aio-proxy agent auth codex`) 进行动态鉴权。
3. **选择代理密钥 (API Key)**：
   - 选择 AIO Proxy 配置中现有的 API Key，或跳过密钥设置（由本地控制面管理）。
4. **历史会话迁移 (Session Migration)**：
   - 向导会自动扫描已有提供商（如默认的 `openai`）下的活跃与归档会话。
   - 询问是否将历史会话一键迁移至新的 AIO Proxy 提供商下，方便无缝续接对话。

---

## 会话迁移与事务回退

会话迁移具备完整的操作日志（Journal）记录。如果迁移后希望还原或回滚：

```sh
aio-proxy agent configure codex --restore-migration <operation-id>
```

`<operation-id>` 可在执行配置时的终端输出中获取，也可在 `aio-proxy agent list` 中查看。

---

## 检查与管理

### 查看接入状态

```sh
aio-proxy agent list
```

输出将展示 Codex 配置文件路径、当前绑定的 Provider ID、活跃 Provider 以及服务连通性状态。

### 解除接入

```sh
aio-proxy agent remove codex
```

该命令会安全移除 Codex 配置文件中由 AIO Proxy 写入的提供商定义，已迁移的会话与其余个人偏好设置均不受影响。
