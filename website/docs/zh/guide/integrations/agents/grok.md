---
description: 使用 aio-proxy agent configure grok 一键接入 xAI Grok Build，免配置 API Key，通过设备码在控制台快速完成安全授权。
---

# xAI Grok Build 接入

xAI Grok Build 是一款专注端到端软件工程与智能编码的命令行 Agent。AIO Proxy 内置对 Grok 的深度集成支持，免去手动配置代理和 Token 的过程。

## 一键配置

确保 AIO Proxy 处于运行状态，然后运行：

```sh
aio-proxy agent configure grok
```

该命令会：

1. 探测本地 Grok 安装位置（默认 `~/.grok`，或读取环境变量 `GROK_HOME`）。
2. 在 Grok 配置文件中写入 AIO Proxy 专用的认证助手（Auth Helper）。
3. 生成唯一的本地安装标识（`installation_id`）。

---

## 登录与授权流程

完成配置后，根据提示执行登录：

```sh
grok login
```

1. 在 Grok 的登录选项中选择 **AIO Proxy**。
2. 终端或浏览器将提示打开 AIO Proxy Dashboard 设备授权页面（形如 `http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH`）。
3. 在 Dashboard 中点击确认授权即可完成绑定。

授权成功后即可列出模型并开始编码：

```sh
# 查看由 AIO Proxy 聚合提供的模型列表
grok models

# 指定模型启动编码任务
grok -m gpt-5
```

:::tip
无需在环境变量中设置 `XAI_API_KEY`，也无需在任何地方粘贴敏感 Token，后续所有请求鉴权均由本地控制面自动流转。
:::

---

## 检查与解除

### 查看接入状态

```sh
aio-proxy agent list
```

将显示 Grok 的检测版本、集成状态（`managed`）、安装 ID 以及授权状态。

### 解除接入

```sh
aio-proxy agent remove grok
```

执行后将自动吊销已颁发的本地凭证，清理写入的代理引导配置，并恢复 Grok 的默认状态。
