import { expect, test } from "bun:test";
import { kimiClientId } from "./rslib.config";

test("build embeds the Kimi OAuth client ID without leaving source plaintext", async () => {
  const [source, config, setup, artifact] = await Promise.all([
    Bun.file("./src/oauth.ts").text(),
    Bun.file("./rslib.config.ts").text(),
    Bun.file("./test/setup.ts").text(),
    Bun.file("./dist/oauth.js").text(),
  ]);
  const encodedClientId = btoa(kimiClientId);

  expect(new Bun.CryptoHasher("sha256").update(kimiClientId).digest("hex")).toBe(
    "9a51d8fba526c54bf355205a99c8325ec07a056024515f826987cb2a042a13ac",
  );
  for (const text of [source, config, setup]) {
    expect(text.includes(kimiClientId)).toBe(false);
    expect(text.includes(encodedClientId)).toBe(false);
  }
  expect(artifact.includes(kimiClientId)).toBe(true);
  expect(artifact.includes("__AIO_PROXY_KIMI_CLIENT_ID__")).toBe(false);
  expect(/\batob\s*\(/u.test(artifact)).toBe(false);
});
