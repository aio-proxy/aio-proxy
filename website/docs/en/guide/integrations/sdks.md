---
description: Integration examples using official OpenAI SDK, Anthropic SDK, and Google GenAI SDK.
---

# SDK Integration & Examples

AIO Proxy is compatible with official client SDKs across Python, TypeScript, and Go. Simply point `base_url` to `http://127.0.0.1:9317/v1`.

---

## Python Examples

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:9317/v1",
    api_key="sk-local"
)

response = client.chat.completions.create(
    model="gpt-5",
    messages=[{"role": "user", "content": "Hello AIO Proxy"}]
)
print(response.choices[0].message.content)
```

### Anthropic SDK

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://127.0.0.1:9317",
    api_key="sk-local"
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello AIO Proxy"}]
)
print(message.content[0].text)
```

---

## TypeScript Examples

### OpenAI SDK (`openai`)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:9317/v1',
  apiKey: 'sk-local',
});

const response = await client.chat.completions.create({
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'Hello AIO Proxy' }],
});

console.log(response.choices[0].message.content);
```
