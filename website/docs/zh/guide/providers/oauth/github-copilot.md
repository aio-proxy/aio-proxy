---
description: 使用 @aio-proxy/plugin-github-copilot 绑定 GitHub Copilot 订阅，免 API Key 调度商业模型。
---

# GitHub Copilot 插件

**插件包名**：`@aio-proxy/plugin-github-copilot`  
**对应 Capability**：`default`

将个人或企业 **GitHub Copilot**（或 Copilot Chat）订阅连接到 AIO Proxy。

## 核心特性

- **动态模型发现**：直接通过 Copilot 内部模型接口动态获取当前订阅拥有的所有模型目录。
- **设备码登录 (Device Flow)**：无需浏览器回调端口，终端直接输出 8 位设备码，在 GitHub 官网输入即可完成绑定。
- **配额与健康度监控**：实时检查 Copilot 会话状态，遇到请求频率限制时自动切换。

## 登录与授权

### 命令行设备码登录

```sh
aio-proxy provider login copilot
```

控制台将输出类似如下信息：

```text
打开网址: https://github.com/login/device
输入设备码: 1234-ABCD
```

在浏览器中授权后，CLI 会自动保存并载入该提供商。

### 复用本机上的 GitHub Copilot 登录

如果已在 GitHub Copilot 中登录，可在 Dashboard 的浏览器授权按钮旁选择 **使用本机上的 GitHub Copilot 登录**。只有在运行服务器的机器上检测到登录时才显示此选项。没有该登录的容器或无头服务器不会显示；在浏览器所在机器上登录，不会向远程服务器提供登录。

也可以在 `aio-proxy provider login` 的交互提示中选择本机登录，或运行：

```sh
aio-proxy provider login --local-sign-in
```

按提示选择 GitHub Copilot 并填写账号选项。只有明确选择使用本机登录后，aio-proxy 才会读取 `~/.config/github-copilot/apps.json` 或旧版 `hosts.json`；设置了 `$XDG_CONFIG_HOME` 时会使用该目录下的 `github-copilot` 存储。登录仅在关联时读取一次，保存的 GitHub 令牌不会轮换。

Provider 会显示 **已关联本机上的 GitHub Copilot 登录** 徽标。移除 Provider 永远不会使 GitHub Copilot 退出登录，也不会改变其登录文件。

#### 恢复关联的 Provider

- Provider 已禁用但 GitHub Copilot 仍可用：在该 Provider 上再次使用本机登录。
- 两边都已退出登录：先在 GitHub Copilot 中重新登录，再在该 Provider 上使用本机登录。
- GitHub Copilot 切换到了其他账号：切回原账号，或为该账号添加新的 Provider。

## 配置示例

```jsonc title="config.jsonc"
{
  "providers": {
    "copilot": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-github-copilot",
      "capability": "default",
      "priority": 15,
      "weight": 100,
    },
  },
}
```
