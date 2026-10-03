---
description: 安装 AIO Proxy 的 macOS 菜单栏客户端，由它在后台运行代理，并随时查看状态、用量与配额。
---

# 桌面客户端 (macOS)

AIO Proxy 桌面客户端是一个 macOS 菜单栏应用。它自带代理，无需安装 Bun 或命令行工具：装好应用，代理就会在后台运行，点一下菜单栏图标即可查看状态、用量与配额。

客户端只是一个随手查看的入口，不是第二个 Dashboard。Provider、路由规则与 API Key 仍在 [Dashboard](../../observability/dashboard-overview) 中管理，客户端会在浏览器中为你打开它。

**系统要求：** Apple Silicon，macOS 13 及以上。Intel Mac 请使用[命令行版本](./installation)。

---

## 安装

1. [下载最新的 `.dmg`](https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/aio-proxy-arm64.dmg)。
2. 打开后，把 **AIO Proxy** 拖入 **应用程序**。
3. 从应用程序中打开 **AIO Proxy**，菜单栏会出现它的图标。

首次启动时，如果本机还没有安装代理，客户端会把它安装为[后台守护服务](./service)并启动，地址为 `http://127.0.0.1:9317`。它与命令行版本共用 `~/.aio-proxy/config.jsonc`，接下来按[快速开始](../getting-started)添加第一个 Provider 即可。

:::warning 请从应用程序文件夹运行
只有从 `/Applications` 或 `~/Applications` 运行时，客户端才会安装后台服务与登录项；`aiop` 命令则要求应用位于 `/Applications`。直接从磁盘映像或下载文件夹打开时，它以只读方式运行，并提示 **Move to Applications**。
:::

---

## 使用

- **点击菜单栏图标**打开面板：代理状态与地址、所选时间窗口内的用量与费用、各 Provider 的剩余配额与重置时间，以及最近 12 个月的活跃热力图。底部是 **Open Dashboard**。
- **右键点击图标**（或点击面板中的 **⋯**）执行操作：**Start**、**Stop**、**Restart**、**Reload config**、**Open logs**、**Open at login** 与 **Check for Updates…**。菜单只列出当前状态下可用的操作。
- 代理停止时图标变暗；有需要关注的情况（例如某个 Provider 持续失败）时，图标右上角会出现一个圆点。

### 已通过命令行安装的服务

如果你已经用 `aio-proxy service install` 运行代理，客户端会把它显示为 **managed by the aio-proxy CLI**，并且从不自行改动它。你仍然可以手动点击 Start、Stop 与 Restart。

### `aiop` 命令

如果你的 shell 中没有 `aiop` 命令，右键菜单会提供 **Install aiop command**。输入管理员密码后，它会把 `/usr/local/bin/aiop` 链接到应用内置的命令行工具，随应用一起更新。你通过其他方式安装的 `aiop` 或 `aio-proxy` 不会被改动。此功能要求应用位于 `/Applications`，且 `/usr/local/bin` 在你的 `PATH` 中。

---

## 更新

客户端会自动检查更新。有新版本时，面板会显示 **Update to &lt;version&gt;…**；也可以在菜单中选择 **Check for Updates…**。点击 **Install and Relaunch** 后，客户端会把它管理的代理重启到新版本，正在进行的请求会被短暂中断。

---

## 卸载

退出客户端后代理仍会继续运行，因为代理由后台服务托管，而不是由客户端托管。要同时移除两者，运行应用内置的命令行工具（如果应用装在 `~/Applications`，请相应替换路径）：

```sh
"/Applications/AIO Proxy.app/Contents/MacOS/aio-proxy" service uninstall
```

然后退出客户端并把它移到废纸篓。`~/.aio-proxy` 中的配置会保留。如果安装过 `aiop` 命令，还需删除 `/usr/local/bin/aiop`，以及指向应用内部的 `/usr/local/bin/aio-proxy`。

客户端自身的日志位于 `~/Library/Logs/aio-proxy-desktop/aio-proxy-desktop.log`。
