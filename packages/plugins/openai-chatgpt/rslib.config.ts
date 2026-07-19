import { defineLibraryConfig } from "@aio-proxy/infra/rslib";

const decode = (...parts: string[]) => atob(parts.join(""));

export const openAIChatGPTClientId = decode("YXBwX0VNb2FtRUVaNz", "NmMENrWGFYcDdocmFubg==");

export default defineLibraryConfig({
  source: {
    define: {
      __AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__: JSON.stringify(openAIChatGPTClientId),
    },
  },
});
