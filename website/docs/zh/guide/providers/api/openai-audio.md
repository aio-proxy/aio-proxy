---
description: 配置 OpenAI Audio 语音合成与音频转写协议，涵盖 Speech、Transcriptions 与 Translations。
---

# OpenAI Audio 协议 (`openai-audio`)

`openai-audio` 对应 OpenAI 官方音频协议体系，涵盖语音合成与识别三大接口：

- 语音合成 (TTS)：`POST /v1/audio/speech`
- 语音转写 (STT)：`POST /v1/audio/transcriptions`
- 语音翻译 (Translation)：`POST /v1/audio/translations`

## 配置示例

```jsonc title="config.jsonc"
{
  "providers": {
    "openai-audio-provider": {
      "kind": "api",
      "protocol": "openai-audio",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "models": ["tts-1", "tts-1-hd", "whisper-1"],
    },
  },
}
```

## 协议特性与运行规则

1. **缺省模型自动兜底**：
   - 客户端调用语音合成未传模型时，默认按 `tts-1` 路由。
   - 客户端调用转写或翻译未传模型时，默认按 `whisper-1` 路由。
   - 提供商必须在 `models` 列表中显式包含上述模型 ID 才能承接对应缺省请求。
2. **流式与二进制响应**：
   - `/v1/audio/speech` 直接输出二进制音频流（如 `audio/mpeg`）。
   - 转写接口支持文本、JSON、Verbose JSON 以及字幕文件（SRT/VTT）输出。
3. **翻译接口限制**：
   - `POST /v1/audio/translations` 仅支持命中提供商的**原始透传**；跨协议转换路径对翻译模式不予支持。
