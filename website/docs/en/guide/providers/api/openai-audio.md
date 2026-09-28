---
description: Configure OpenAI Audio speech synthesis and transcription endpoints.
---

# OpenAI Audio Protocol (`openai-audio`)

Connects to speech synthesis (`/v1/audio/speech`) and transcription (`/v1/audio/transcriptions`).

```jsonc title="config.jsonc"
{
  "providers": {
    "audio-service": {
      "kind": "api",
      "protocol": "openai-audio",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "models": ["whisper-1", "tts-1", "tts-1-hd"],
    },
  },
}
```
