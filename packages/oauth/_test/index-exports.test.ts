import { describe, expect, test } from "bun:test";
import type { ChatGPTModel, ChatGPTPayload } from "../src";
import * as oauth from "../src";

describe("@aio-proxy/oauth root exports", () => {
  test("exports the ChatGPT provider surface and hides internals", () => {
    const provider = new oauth.OpenAIChatGPTOAuthProvider();

    expect(oauth.openAIChatGPTOAuthProvider).toBeInstanceOf(oauth.OpenAIChatGPTOAuthProvider);
    expect(provider.loginForm).toEqual({
      label: "Login with ChatGPT (Plus/Pro)",
      prompts: [],
      type: "oauth",
    });
    expect("refreshAccessToken" in oauth).toBe(false);
    expect("createLoopbackServer" in oauth).toBe(false);
    expect("generatePKCE" in oauth).toBe(false);
    expect("extractAccountId" in oauth).toBe(false);
    expect("tokenResponseSchema" in oauth).toBe(false);
  });

  test("exports ChatGPT types at compile time", () => {
    const payload: ChatGPTPayload = {
      access: "access",
      accountId: "account",
      expires: 1,
      models: [{ alias: "gpt-5.5", id: "gpt-5.5" } satisfies ChatGPTModel],
      refresh: "refresh",
    };

    expect(payload.models[0]?.alias).toBe("gpt-5.5");
  });
});
