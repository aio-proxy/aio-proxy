import { describe, expect, test } from "bun:test";

import { Auth } from "../src";
import { OpenAIChatGPTOAuthProvider } from "../src/openai-chatgpt";

describe("OpenAIChatGPTOAuthProvider", () => {
  test("loginForm is the fixed ChatGPT oauth form", () => {
    const provider = new OpenAIChatGPTOAuthProvider();

    expect(provider.loginForm).toEqual({
      type: "oauth",
      label: "Login with ChatGPT (Plus/Pro)",
      prompts: [],
    });
  });

  test("models returns the hardcoded ChatGPT whitelist", async () => {
    const provider = new OpenAIChatGPTOAuthProvider();

    await expect(
      provider.models({ access: "a", expires: 0, refresh: "r", accountId: "u", models: [] }),
    ).resolves.toEqual([
      { alias: "gpt-5.5", id: "gpt-5.5" },
      { alias: "gpt-5.4", id: "gpt-5.4" },
      { alias: "gpt-5.4-mini", id: "gpt-5.4-mini" },
      { alias: "gpt-5.3-codex-spark", id: "gpt-5.3-codex-spark" },
    ]);
  });

  test("login stores payload and returns authenticated result", async () => {
    const accountId = `account-${crypto.randomUUID()}`;
    const providerId = `chatgpt-${accountId}`;
    const provider = new OpenAIChatGPTOAuthProvider({
      createLoopbackServer: () => fakeLoopback,
      exchangeCodeForTokens: async (code, verifier, options) => {
        expect(code).toBe("auth-code-123");
        expect(verifier).toBe("verifier-123");
        expect(options).toEqual({ redirectUri: "http://localhost:1455/auth/callback" });
        return {
          access: "access-token",
          accountId,
          expires: 1_700_000_900_000,
          refresh: "refresh-token",
        };
      },
      generatePKCE: async () => ({ challenge: "challenge-123", verifier: "verifier-123" }),
      generateState: () => "state-123",
    });

    try {
      const result = await provider.login(
        {},
        {
          onAuth: (info) => {
            expect(info).toEqual({
              url: "https://auth.openai.com/oauth/authorize?client_id=Iv1.b507a08c87ecfe98&code_challenge=challenge-123&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&state=state-123",
            });
          },
        },
      );

      expect(result).toEqual({
        accountLabel: accountId,
        payload: {
          access: "access-token",
          accountId,
          expires: 1_700_000_900_000,
          models: [
            { alias: "gpt-5.5", id: "gpt-5.5" },
            { alias: "gpt-5.4", id: "gpt-5.4" },
            { alias: "gpt-5.4-mini", id: "gpt-5.4-mini" },
            { alias: "gpt-5.3-codex-spark", id: "gpt-5.3-codex-spark" },
          ],
          refresh: "refresh-token",
        },
        providerId,
        status: "authenticated",
        userId: accountId,
      });
      expect(Auth.get("openai-chatgpt", providerId)?.payload).toEqual({
        access: "access-token",
        accountId,
        accountLabel: accountId,
        expires: 1_700_000_900_000,
        models: [
          { alias: "gpt-5.5", id: "gpt-5.5" },
          { alias: "gpt-5.4", id: "gpt-5.4" },
          { alias: "gpt-5.4-mini", id: "gpt-5.4-mini" },
          { alias: "gpt-5.3-codex-spark", id: "gpt-5.3-codex-spark" },
        ],
        refresh: "refresh-token",
      });
      expect(Auth.get("openai-chatgpt", providerId)?.accountFingerprint).toBe(providerId);
    } finally {
      Auth.del("openai-chatgpt", providerId);
    }
  });

  test("login rejects cleanly when aborted before code arrives", async () => {
    const controller = new AbortController();
    const provider = new OpenAIChatGPTOAuthProvider({
      createLoopbackServer: () => ({
        close: () => undefined,
        redirectUri: "http://localhost:1455/auth/callback",
        waitForCode: (signal) =>
          new Promise<never>((_resolve, reject) => {
            if (signal?.aborted === true) {
              reject(new Error("aborted"));
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
      }),
      exchangeCodeForTokens: async () => {
        throw new Error("unexpected exchange");
      },
      generatePKCE: async () => ({ challenge: "challenge-123", verifier: "verifier-123" }),
      generateState: () => "state-123",
    });

    const login = provider.login(
      {},
      {
        onAuth: () => undefined,
        signal: controller.signal,
      },
    );
    controller.abort();
    await expect(login).rejects.toThrow("aborted");
  });
});

const fakeLoopback = {
  close: () => undefined,
  redirectUri: "http://localhost:1455/auth/callback",
  waitForCode: async () => ({ code: "auth-code-123", state: "state-123" }),
} as const;
