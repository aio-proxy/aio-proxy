---
description: 在 macOS、Windows 或 Linux 上安装 AIO Proxy 桌面客户端。它在后台运行代理，并在菜单栏或系统托盘中显示状态、用量与配额。
---

# 桌面客户端

AIO Proxy 桌面客户端自带代理，无需安装 Bun 或命令行工具：装好应用，代理就会在后台运行，点一下菜单栏或系统托盘图标即可查看状态、用量与配额。

客户端只是一个随手查看的入口，不是第二个 Dashboard。Provider、路由规则与 API Key 仍在 [Dashboard](../../observability/dashboard-overview) 中管理，客户端会在浏览器中为你打开它。

---

## 下载

| 平台    | 系统要求                       | 下载                                                                                                                                                                                                                                    |
| ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | Apple Silicon，macOS 13 及以上 | [`.dmg`](https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/aio-proxy-arm64.dmg)                                                                                                                                     |
| Windows | x64                            | [安装程序 (`.exe`)](https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/aio-proxy-x64-setup.exe)                                                                                                                      |
| Linux   | x86_64 或 arm64                | [AppImage x86_64](https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/aio-proxy-x86_64.AppImage) · [AppImage arm64](https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/aio-proxy-aarch64.AppImage) |

历史版本见 [GitHub Releases](https://github.com/aio-proxy/aio-proxy/releases)。Intel Mac 及其他系统请使用[命令行版本](./installation)。

---

## 安装

### macOS

1. 打开 `.dmg`，把 **AIO Proxy** 拖入 **应用程序**。
2. 从应用程序中打开 **AIO Proxy**，菜单栏会出现它的图标。

:::warning 请从应用程序文件夹运行
只有从 `/Applications` 或 `~/Applications` 运行时，客户端才会安装后台服务与登录项；`aiop` 命令则要求应用位于 `/Applications`。直接从磁盘映像或下载文件夹打开时，它以只读方式运行，并提示 **Move to Applications**。
:::

### Windows

运行安装程序。它只为当前用户安装到 `%LOCALAPPDATA%\AIO Proxy`，不需要管理员权限。安装后通知区域会出现客户端图标。

:::warning SmartScreen 提示
安装程序暂未进行代码签名，Windows SmartScreen 可能会发出警告。请点击 **更多信息**，再选择 **仍要运行**。
:::

### Linux

给 AppImage 加上可执行权限后运行：

```sh
chmod +x aio-proxy-*.AppImage
./aio-proxy-*.AppImage
```

请把它放在你有写权限的目录中（例如 `~/Applications`），客户端才能自动更新。托盘图标需要桌面环境支持系统托盘（StatusNotifierItem），GNOME 需要安装 AppIndicator 扩展。没有托盘时，面板会以普通窗口打开，关闭窗口即退出客户端，代理仍会继续运行。

### 首次启动

首次启动时，如果本机还没有安装代理，客户端会把它安装为[后台守护服务](./service)并启动，地址为 `http://127.0.0.1:9317`。它与命令行版本共用 `~/.aio-proxy/config.jsonc`，接下来按[快速开始](../getting-started)添加第一个 Provider 即可。

---

## 使用

- **点击图标**打开面板：代理状态与地址、所选时间窗口内的用量与费用、各 Provider 的剩余配额与重置时间，以及最近 12 个月的活跃热力图。底部是 **Open Dashboard**。在点击图标会直接弹出菜单的 Linux 桌面上，请选择 **Open Panel**。
- **右键点击图标**（或点击面板中的 **⋯**）执行操作：**Start**、**Stop**、**Restart**、**Reload config**、**Open logs**、**Open at login** 与 **Check for Updates…**。菜单只列出当前状态下可用的操作。

### 已通过命令行安装的服务

如果你已经用 `aio-proxy service install` 运行代理，客户端会把它显示为 **managed by the aio-proxy CLI**，并且从不自行改动它。你仍然可以手动点击 Start、Stop 与 Restart。

### `aiop` 命令

如果你的 shell 中没有 `aiop` 命令，菜单会提供 **Install aiop command**。它会让 `aiop` 指向应用内置的命令行工具，随应用一起更新。你通过其他方式安装的 `aiop` 或 `aio-proxy` 不会被改动。

| 平台    | 安装位置                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------- |
| macOS   | `/usr/local/bin/aiop`，需要输入管理员密码。要求应用位于 `/Applications`，且 `/usr/local/bin` 在 `PATH` 中。           |
| Windows | `%LOCALAPPDATA%\aio-proxy-desktop\bin\shims` 中的启动脚本，该目录会追加到用户 `PATH` 末尾。需要新开一个终端才能使用。 |
| Linux   | `~/.local/bin/aiop`。要求 `~/.local/bin` 在 `PATH` 中。                                                               |

---

## 更新

客户端会自动检查更新，并校验每个更新的签名。有新版本时，面板会显示 **Update to &lt;version&gt;…**；也可以在菜单中选择 **Check for Updates…**。更新完成后，客户端会把它管理的代理重启到新版本，正在进行的请求会被短暂中断。

---

## 卸载

退出客户端后代理仍会继续运行，因为代理由后台服务托管，而不是由客户端托管。所有平台上，`~/.aio-proxy` 中的配置都会保留。

- **macOS：** 先用应用内置的命令行工具移除后台服务（如果应用装在 `~/Applications`，请相应替换路径），再退出客户端并把它移到废纸篓：

  ```sh
  "/Applications/AIO Proxy.app/Contents/MacOS/aio-proxy" service uninstall
  ```

  如果安装过 `aiop` 命令，还需删除 `/usr/local/bin/aiop`，以及指向应用内部的 `/usr/local/bin/aio-proxy`。

- **Windows：** 在 **设置 › 应用** 中卸载 **AIO Proxy**。卸载程序会一并移除客户端安装的后台服务、`aiop` 命令与登录项。

- **Linux：** AppImage 没有卸载程序。请先移除后台服务，再删除 AppImage 与 `~/.local/share/aio-proxy-desktop`：

  ```sh
  ~/.local/share/aio-proxy-desktop/bin/aio-proxy service uninstall
  ```

客户端自身的日志位于：macOS 的 `~/Library/Logs/aio-proxy-desktop`，Windows 的 `%LOCALAPPDATA%\aio-proxy-desktop\logs`，Linux 的 `~/.local/state/aio-proxy-desktop`。
