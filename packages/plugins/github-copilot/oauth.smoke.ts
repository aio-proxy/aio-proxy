import { expect, test } from "bun:test";
import { githubCopilotClientId } from "./rslib.config";

test("build embeds the GitHub OAuth client ID without leaving source plaintext", async () => {
  const [source, config, setup, artifact] = await Promise.all([
    Bun.file("./src/github-api/login.ts").text(),
    Bun.file("./rslib.config.ts").text(),
    Bun.file("./test/setup.ts").text(),
    Bun.file("./dist/github-api/login.js").text(),
  ]);

  expect(new Bun.CryptoHasher("sha256").update(githubCopilotClientId).digest("hex")).toBe(
    "9954bfea80f3d9092fcfed1cf263006469bc818ce55ee7114580fe2a8142af71",
  );
  for (const text of [source, config, setup]) {
    expect(text.includes(githubCopilotClientId)).toBe(false);
    expect(text.includes(btoa(githubCopilotClientId))).toBe(false);
  }
  expect(artifact.includes(githubCopilotClientId)).toBe(true);
  expect(artifact.includes("__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__")).toBe(false);
  expect(/\batob\s*\(/u.test(artifact)).toBe(false);
});
