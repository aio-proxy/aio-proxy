---
description: AIO Proxy 配置文件的格式规范、环境变量模板插值与命令行管理操作。
---

# 配置文件与环境模板

AIO Proxy 采用具有注释支持的 JSONC（带注释的 JSON）作为配置文件格式。

默认配置文件路径为：

- **macOS / Linux**：`~/.aio-proxy/config.jsonc`

通过设置环境变量 `AIO_PROXY_HOME` 可以自定义配置与数据根目录。

## JSON Schema 智能校验

配置文件的首行推荐包含官方 `$schema` 引用：

```jsonc
{
  "$schema": "https://unpkg.com/@aio-proxy/types/config.schema.json",
  "providers": {
    // ...
  },
}
```

在 VS Code、Cursor 或 WebStorm 等编辑器中，Schema 会自动为你提供每个字段的补全提示、必填项校验和文档悬浮说明。

## 环境变量模板插值 (`{{env.NAME}}`)

为了避免在配置文件中硬编码敏感 API Key 或私密参数，AIO Proxy 支持使用 Handlebars 风格的双花括号模板语法动态引用系统环境变量：

```jsonc title="config.jsonc"
{
  "server": {
    "password": "{{env.DASHBOARD_PASSWORD}}",
  },
  "providers": {
    "openai": {
      "kind": "api",
      "protocol": "openai-response",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "models": ["gpt-5"],
    },
  },
}
```

AIO Proxy 启动或重新加载配置时，会自动将 `{{env.NAME}}` 替换为当前的真实环境变量值。如果变量不存在，验证或启动时会给出明确的未解析警告或错误。

## CLI 配置文件管理

AIO Proxy 提供了便捷的 `config` 命令集用于日常维护：

### 1. 查看配置文件路径

```sh
aio-proxy config path
```

输出当前实例实际加载的 `config.jsonc` 绝对路径。

### 2. 在系统默认编辑器中打开

```sh
aio-proxy config edit
```

使用环境变量 `$EDITOR`（未配置时使用系统默认关联程序）直接打开配置文件。

### 3. 校验配置文件有效性

```sh
aio-proxy config validate
```

执行严格的 Schema 与逻辑关联性校验（如检查主备代理依赖、模型别名目标是否存在、多端点协议是否合规）。如果文件有语法或语义错误，会精确打印出行号和字段路径。

### 4. 打印生效配置（自动脱敏）

```sh
aio-proxy config show
```

打印当前合并解析后的完整生效配置对象。所有涉及密钥（如 `apiKey`、`password`、代理账密等）的敏感字段均会自动被遮蔽脱敏，方便检查配置是否符合预期。

### 5. 热重载配置

```sh
aio-proxy reload
```

向正在运行的 AIO Proxy 进程发送重载信号，立即重新读取配置文件而无需重启服务进程或中断已有长连接。
