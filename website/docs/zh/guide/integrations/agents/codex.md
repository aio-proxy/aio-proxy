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

## 模型目录与刷新

首次通过 CLI 向导或 Dashboard 接入时，AIO Proxy 会获取完整模型目录，将其保存到当前 Codex home 的托管目录，并设置 `model_catalog_json`。本地 Codex 默认读取这份完整目录，第三方模型使用完整任务指导；匹配的官方模型保留官方提示词与附加消息。解析 Codex home 时尊重 `CODEX_HOME`，只管理这一处接入。

HTTP 接口 `GET /v1/models?client_version=<版本>` 默认使用精简任务指导，以减少模型发现响应的大小。`codex_instructions=compact` 可显式选择精简目录，`codex_instructions=full` 可导出完整目录。精简指导改变了第三方模型的提示词，不能据此保证其行为与完整指导等价；官方提示词仍保留。HTTP 目录受 Codex 的 1 MiB 响应上限限制，完整目录较大时应使用本地文件。

本地托管目录会在以下四个入口检查更新：

1. AIO Proxy 服务启动后。
2. Provider 模型快照成功更新后，例如配置重载或模型重新发现。
3. 已通过鉴权的 Codex 模型目录请求到达时。
4. 服务运行期间每六小时的周期检查。

**更新文件后需要重启 Codex CLI 或 Desktop 才能生效**，因为 Codex 只在启动时加载本地目录。后台刷新失败时保留原有目录；首次接入若无法获取或保存有效目录，接入不会报告成功。

远端服务和 Docker 容器只能管理其进程可访问、且符合本地接入条件的 Codex home，无法替另一台机器或容器外的 Codex 写目录。此时客户端可通过 HTTP 加载精简目录；若使用完整本地目录，需要在客户端机器获取文件并配置其本地 `model_catalog_json`。HTTP 导出不提供任意模型数量的容量保证。

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

该命令会安全移除 Codex 配置文件中由 AIO Proxy 写入的提供商定义，并恢复接入前的个人模型目录配置（如有）。如果接入后手动修改了托管字段，会保留这些个人修改并报告部分移除；已迁移的会话与其余个人偏好设置均不受影响。
