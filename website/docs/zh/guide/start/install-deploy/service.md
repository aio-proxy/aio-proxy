---
description: 使用 aio-proxy service 将代理安装为开机自启的系统后台守护进程（macOS launchd 与 Linux systemd）。
---

# 后台守护服务 (Service)

AIO Proxy 内置了跨平台的用户级服务管理功能，可以在操作系统级别注册为开机自动启动、异常自动拉起的后台守护服务：

- **macOS**：自动注册并托管为 `launchd` 用户 Agent（配置文件位于 `~/Library/LaunchAgents/`）。
- **Linux**：自动注册并托管为 `systemd` 用户服务（配置文件位于 `~/.config/systemd/user/`）。

无需使用 `nohup`、`screen` 或第三方进程守护工具。

## 安装与开机自启

运行以下命令安装并启用开机自启服务：

```sh
aio-proxy service install
```

服务安装成功后会自动在后台启动。

## 常用服务管理命令

```sh
# 查看系统后台服务状态
aio-proxy service status

# 启动后台服务
aio-proxy service start

# 停止后台服务
aio-proxy service stop

# 重启后台服务
aio-proxy service restart

# 卸载后台服务
aio-proxy service uninstall
```

## 服务的运行特点

1. **用户空间隔离**：无需 `sudo` 或管理员权限，所有服务脚本均以当前登录用户身份运行。
2. **自动拉起**：若进程因内存溢出或意外退出，系统服务管理器会自动尝试重新拉起。
3. **开机自启**：系统启动或当前用户登录时自动常驻运行。
4. **日志输出**：后台服务的标准输出与错误日志会自动交由系统原生日志机制或通过 `server.logging` 配置持久化至指定目录。
