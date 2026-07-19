import { expect, test } from "bun:test";
import { openAIChatGPTClientId } from "./rslib.config";

test("build embeds the ChatGPT OAuth client ID without leaving source plaintext", async () => {
  const [source, config, setup, artifact] = await Promise.all([
    Bun.file("./src/oauth-flow.ts").text(),
    Bun.file("./rslib.config.ts").text(),
    Bun.file("./test/setup.ts").text(),
    Bun.file("./dist/oauth-flow.js").text(),
  ]);

  expect(new Bun.CryptoHasher("sha256").update(openAIChatGPTClientId).digest("hex")).toBe(
    "584341c2f0e88ad1f7c6856553d81dc4776ff42c43951daed3e2d8d91552eaa2",
  );
  for (const text of [source, config, setup]) {
    expect(text.includes(openAIChatGPTClientId)).toBe(false);
    expect(text.includes(btoa(openAIChatGPTClientId))).toBe(false);
  }
  expect(artifact.includes(openAIChatGPTClientId)).toBe(true);
  expect(artifact.includes("__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__")).toBe(false);
  expect(/\batob\s*\(/u.test(artifact)).toBe(false);
});
