---
description: 了解 AIO Proxy 原生 Agent 集成体系（aio-proxy agent），免手动配置 Token，一键桥接本地智能编码 Agent。
---

# 原生 Agent 集成概述

现代 AI 编码 Agent（如 OpenAI Codex、xAI Grok Build、OpenCode、Pi、OMP）通常作为本地 CLI 或桌面应用运行，各自拥有专属的配置结构、会话存储与认证机制。

手动将这些工具对接到本地代理往往需要复制 Base URL、修改深层配置文件，并在更新后重复维护。为此，AIO Proxy 提供了原生的 `aio-proxy agent` 命令体系：

- **自动化探测**：自动识别系统已安装的 Agent 及其宿主版本与配置路径。
- **免贴 Token 桥接**：通过本地控制面动态生成和轮转专属访问凭证，支持 Dashboard 设备码一键授权。
- **配置与会话无侵入**：安全维护代理配置段；支持历史会话迁移与事务回退，移除时无损还原用户个人设置。

---

## 受支持的 Agent 清单

| Agent 标识 | 目标工具                   | 集成机制与原理                                       | 支持详情                           |
| :--------- | :------------------------- | :--------------------------------------------------- | :--------------------------------- |
| `codex`    | OpenAI Codex CLI / Desktop | 交互式向导配置提供商、管理凭据，支持历史会话无损迁移 | [Codex 接入指南](./codex.md)       |
| `grok`     | xAI Grok Build             | 注入本地 Auth Helper，通过控制台设备码完成一键授权   | [Grok 接入指南](./grok.md)         |
| `opencode` | OpenCode                   | 自动解析配置目录并注入动态插件模块，支持原生模型协商 | [OpenCode 接入指南](./opencode.md) |
| `pi`       | Pi Coding Agent            | 探测 `~/.pi/agent/extensions` 扩展体系并注入桥接模块 | [Pi 与 OMP 接入指南](./pi-omp.md)  |
| `omp`      | Oh-My-Pi (OMP)             | 解析 OMP 活动配置并注入扩展，支持 `/login aio-proxy` | [Pi 与 OMP 接入指南](./pi-omp.md)  |

---

## 常用管理命令

### 1. 查看已接入的 Agent 状态

通过 `agent list` 查看所有受支持 Agent 的检测状态、适配器版本、授权有效性与配置完整度：

```sh
aio-proxy agent list
```

若需连通性自检与目录结构校验，添加 `--check` 参数：

```sh
aio-proxy agent list --check
```

### 2. 解除 Agent 接入

当需要将某个 Agent 还原至接入前状态时，运行：

```sh
aio-proxy agent remove <codex|grok|opencode|pi|omp>
```

AIO Proxy 会：

- 吊销该集成在本地控制面颁发的全部临时凭证。
- 仅剔除 AIO Proxy 写入的插件或配置段，完整保留用户的其余个人偏好与自定义配置。

### 3. 手动吊销凭证

如果需要根据安装 ID 撤销某次授权：

```sh
aio-proxy agent revoke <installation-id>
```
