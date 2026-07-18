import { openAIChatGPTClientId } from "../rslib.config";

const fingerprint = new Bun.CryptoHasher("sha256").update(openAIChatGPTClientId).digest("hex");
if (fingerprint !== "584341c2f0e88ad1f7c6856553d81dc4776ff42c43951daed3e2d8d91552eaa2") {
  throw new Error("OpenAI ChatGPT OAuth credential fingerprint mismatch");
}

Object.assign(globalThis, {
  __AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__: openAIChatGPTClientId,
});
