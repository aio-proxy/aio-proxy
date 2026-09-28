---
description: AIO Proxy CLI 全部命令与参数参考手册：服务运行、状态诊断、配置管理、提供商运维与 Agent 集成。
---

# CLI 命令行手册

AIO Proxy 命令行工具提供全局命令 `aio-proxy` 及短别名 `aiop`。

## 全局选项

```text
Usage: aio-proxy [options] [command]

Options:
  -v, --version       输出当前 CLI 版本号
  --lang <locale>     指定输出语言 (en 或 zh)
  -h, --help          查看帮助信息
```

---

## 常用子命令总览

### 1. 服务控制

#### `aio-proxy run`

在前台启动 AIO Proxy 服务。

- `--open`：启动成功后自动在默认浏览器中打开 Dashboard。
- `--port <port>`：临时覆盖监听端口（默认 `9317`）。

#### `aio-proxy reload`

向正在运行的 AIO Proxy 发送重载信号，无缝重新读取配置文件。

#### `aio-proxy status`

查看 AIO Proxy 是否正在运行。

- `--deep`：执行深度状态检查，输出监听端口、运行时 PID、健康检查响应时间与各 Provider 存活状态。

#### `aio-proxy dashboard`

直接在默认浏览器中打开运行中实例的 Dashboard 界面。

---

### 2. 后台服务管理 (`service`)

用于在操作系统级别将 AIO Proxy 安装为开机自启的后台守护进程。

- `aio-proxy service install`：注册并安装后台服务（macOS `launchd` / Linux `systemd`）。
- `aio-proxy service uninstall`：卸载后台服务。
- `aio-proxy service start`：启动后台服务。
- `aio-proxy service stop`：停止后台服务。
- `aio-proxy service restart`：重启后台服务。
- `aio-proxy service status`：查看系统服务管理器的托管状态。

---

### 3. 配置管理 (`config`)

- `aio-proxy config path`：输出当前生效的 `config.jsonc` 绝对路径。
- `aio-proxy config edit`：在终端配置的文本编辑器中直接打开配置文件。
- `aio-proxy config validate [path]`：执行严格的静态语法与 Schema 结构校验。
- `aio-proxy config show`：打印解析生效的完整配置对象（敏感字段自动脱敏）。

---

### 4. 提供商运维 (`provider`)

- `aio-proxy provider list`：列出当前运行实例加载的全部提供商。
  - `--probe`：对所有提供商并发执行在线存活探测。
- `aio-proxy provider login [capability]`：交互式执行 OAuth 厂商登录。
- `aio-proxy provider import [path]`：从本地认证文件或目录中导入提供商凭据。
- `aio-proxy provider test <provider-id>`：针对特定的提供商发起在线探针测试。

---

### 5. 原生 Agent 集成 (`agent`)

- `aio-proxy agent list`：列出已识别的 Agent 宿主环境及配置漂移检测报告。
- `aio-proxy agent configure <opencode|pi|omp|codex|grok>`：一键配置指定 Agent，免贴 Token 安全桥接。
- `aio-proxy agent remove <opencode|pi|omp|codex|grok>`：从指定 Agent 中移除 AIO Proxy 集成并还原用户配置。
- `aio-proxy agent revoke <installation-id>`：根据安装 ID 撤销特定客户端的访问令牌。
- `aio-proxy agent auth <codex|grok>`：触发 Agent 专用认证流程。

---

### 6. 环境诊断与维护

#### `aio-proxy doctor`

全面体检本地运行环境：检查 Node/Bun 运行时、配置文件合法性、本地回环绑定权限、网络连通性及代理节点可用性。

#### `aio-proxy upgrade` (或 `update`)

自动检测远程最新发布的版本并执行在线升级。

#### `aio-proxy completion <shell>`

生成 Shell 自动补全脚本（支持 `bash`、`zsh`、`fish`）。
