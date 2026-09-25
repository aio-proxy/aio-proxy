---
description: Python 与 TypeScript 环境下使用 OpenAI、Anthropic、Google SDK 调用 AIO Proxy 的代码示例。
---

# SDK 代码示例

只需将官方 SDK 初始化的 `baseURL` 指向本地的 AIO Proxy 端点，现有业务代码逻辑完全无需修改。

## OpenAI SDK

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:9317/v1",
    api_key="sk-aio-key",  # 对应 server.apiKeys 中的密钥
)

response = client.chat.completions.create(
    model="gpt-5",
    messages=[{"role": "user", "content": "你好，介绍一下 AIO Proxy。"}],
)

print(response.choices[0].message.content)
```

### TypeScript / Node.js

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://127.0.0.1:9317/v1',
  apiKey: 'sk-aio-key',
});

const completion = await openai.chat.completions.create({
  model: 'gpt-5',
  messages: [{ role: 'user', content: '你好！' }],
});

console.log(completion.choices[0].message.content);
```

---

## Anthropic SDK

### Python

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:9317",
    api_key="sk-aio-key",
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "用一句话总结量子计算。"}],
)

print(message.content[0].text)
```

### TypeScript

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  baseURL: 'http://127.0.0.1:9317',
  apiKey: 'sk-aio-key',
});

const message = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: '你好！' }],
});

console.log(message.content);
```

---

## 跨协议调用的透明体验

哪怕你在代码中使用 **OpenAI SDK** 请求 `claude-sonnet-4-6`，或者使用 **Anthropic SDK** 请求 `gpt-5`：

1. AIO Proxy 会透明接收入站协议。
2. 自动将其转码并派发给提供该模型的对应上游。
3. 将上游结果无缝包装回发起方 SDK 所期望的数据格式并返回。
