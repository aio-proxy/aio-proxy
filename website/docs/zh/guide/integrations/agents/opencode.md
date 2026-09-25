---
description: 使用 aio-proxy agent configure opencode 一键接入 OpenCode 编码助手，自动注入本地扩展插件并完成模型目录协商。
---

# OpenCode 接入

OpenCode 是一款灵活的终端开源代码助手。AIO Proxy 通过专属的扩展插件模块与其无缝桥接。

## 一键配置

确保 AIO Proxy 已启动，在终端执行：

```sh
aio-proxy agent configure opencode
```

配置命令会自动：

1. 调用 `opencode debug paths` 探测 OpenCode 的配置与插件存储目录。
2. 在 OpenCode 插件目录中注入 AIO Proxy 专用的安全桥接扩展（`aio-proxy` 目录及入口文件）。
3. 向本地控制面注册独立的安装凭据。

---

## 登录与使用

配置完成后，按提示执行 OpenCode 登录认证：

```sh
opencode auth login --provider aio-proxy
```

登录完成后重启 OpenCode，即可在模型选择器中看到 AIO Proxy 聚合发布的所有可用模型，支持跨协议智能调度与故障回退。

---

## 检查与移除

### 查看状态

```sh
aio-proxy agent list
```

检查 OpenCode 插件的版本匹配度（Schema 兼容性）、接入状态及授权有效期。

### 解除接入

```sh
aio-proxy agent remove opencode
```

命令会自动向本地服务请求吊销安装授权，并干净移除 OpenCode 插件目录中的 AIO Proxy 模块。
