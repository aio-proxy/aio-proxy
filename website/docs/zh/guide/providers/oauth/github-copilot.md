---
description: 使用 @aio-proxy/plugin-github-copilot 绑定 GitHub Copilot 订阅，免 API Key 调度商业模型。
---

# GitHub Copilot 插件

**插件包名**：`@aio-proxy/plugin-github-copilot`  
**对应 Capability**：`copilot`

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

## 配置示例

```jsonc title="config.jsonc"
{
  "providers": {
    "copilot": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-github-copilot",
      "capability": "copilot",
      "priority": 15,
      "weight": 100,
    },
  },
}
```
