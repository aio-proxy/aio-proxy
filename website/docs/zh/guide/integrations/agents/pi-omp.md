---
description: 使用 aio-proxy agent configure 一键接入 Pi Coding Agent 与 Oh-My-Pi (OMP)，自动部署插件扩展与免密会话桥接。
---

# Pi 与 Oh-My-Pi (OMP) 接入

Pi Coding Agent 与 Oh-My-Pi (OMP) 拥有高度模块化的插件扩展能力。AIO Proxy 通过向其扩展目录注入标准 Bridge 插件，实现模型无缝透传。

## Pi Coding Agent 接入

### 1. 一键配置

确保 AIO Proxy 正常运行：

```sh
aio-proxy agent configure pi
```

- **路径探测**：默认探测 `~/.pi/agent/extensions`，亦可读取环境变量 `PI_CODING_AGENT_DIR`。
- **扩展注入**：在 extensions 目录下写入专属的 `aio-proxy` 桥接模块并注册安装凭据。

### 2. 登录与启用

在 Pi 的对话提示符或终端中执行：

```text
/login aio-proxy
```

随后重启或重新加载 Pi，即可直接选用 AIO Proxy 统一维护的模型。

---

## Oh-My-Pi (OMP) 接入

### 1. 一键配置

在终端执行：

```sh
aio-proxy agent configure omp
```

- **环境检测**：自动调用 `omp config path` 获取当前活动 Profile 的存储路径。
- **扩展部署**：将 AIO Proxy 桥接模块注入其 extensions 目录。

### 2. 启用与生效

在 OMP 中执行登录：

```text
/login aio-proxy
```

---

## 管理与移除

### 查看集成状态

```sh
aio-proxy agent list
```

### 解除接入

```sh
# 解除 Pi 接入
aio-proxy agent remove pi

# 解除 OMP 接入
aio-proxy agent remove omp
```

命令会撤销对应的本地访问令牌，并清理注入的扩展文件夹。
