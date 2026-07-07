import { describe, expect, test } from "bun:test";
import { extractAccountId } from "../src/openai-chatgpt/jwt";
import {
  ChatGPTOAuthAbortedError,
  ChatGPTOAuthPortInUseError,
  ChatGPTStateMismatchError,
  createLoopbackServer,
} from "../src/openai-chatgpt/loopback";
import { base64url, generatePKCE, generateState } from "../src/openai-chatgpt/pkce";
import { tokenResponseSchema } from "../src/openai-chatgpt/schema";

describe("extractAccountId", () => {
  test("extractAccountId prefers top-level claim", () => {
    const token = buildJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "nested-account" },
      chatgpt_account_id: "top-account",
      organizations: [{ id: "org-account" }],
    });

    expect(extractAccountId(token)).toBe("top-account");
  });

  test("extractAccountId reads nested auth claim", () => {
    const token = buildJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "nested-account" },
    });

    expect(extractAccountId(token)).toBe("nested-account");
  });

  test("extractAccountId ignores flat nested-looking auth key", () => {
    const token = buildJwt({
      "https://api.openai.com/auth.chatgpt_account_id": "wrong-account",
    });

    expect(extractAccountId(token)).toBeUndefined();
  });

  test("extractAccountId reads first organization id", () => {
    const token = buildJwt({
      organizations: [{ id: "org-account" }, { id: "other-account" }],
    });

    expect(extractAccountId(token)).toBe("org-account");
  });

  test("extractAccountId returns undefined for malformed token", () => {
    expect(extractAccountId("not-a-jwt")).toBeUndefined();
    expect(extractAccountId("header.not-base64url.signature")).toBeUndefined();
  });

  test("generatePKCE produces valid verifier and challenge", async () => {
    for (let index = 0; index < 100; index += 1) {
      const { challenge, verifier } = await generatePKCE();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const expectedChallenge = base64url(new Uint8Array(digest));

      expect(verifier.length).toBe(43);
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/);
      expect(challenge).toBe(expectedChallenge);
      expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
      expect(challenge).not.toContain("=");
    }
  });

  test("base64url strips padding", () => {
    expect(base64url(new Uint8Array([0xff]))).toBe("_w");
  });

  test("generateState produces URL-safe state", () => {
    const state = generateState();

    expect(state).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });
});

describe("tokenResponseSchema", () => {
  test("tokenResponseSchema parses valid response", () => {
    const response = tokenResponseSchema.parse({
      access_token: "access-token",
      expires_in: 3_600,
      id_token: "id-token",
      refresh_token: "refresh-token",
      scope: "chatgpt",
    });

    expect(response).toEqual({
      access_token: "access-token",
      expires_in: 3_600,
      id_token: "id-token",
      refresh_token: "refresh-token",
      scope: "chatgpt",
    });
  });

  test("tokenResponseSchema rejects missing access_token", () => {
    expect(() =>
      tokenResponseSchema.parse({
        refresh_token: "refresh-token",
      }),
    ).toThrow();
  });
});

describe("createLoopbackServer", () => {
  test("loopback resolves on matching state", async () => {
    const loopback = createLoopbackServer("expected-state", { port: 0 });

    try {
      const url = new URL(loopback.redirectUri);

      expect(url.hostname).toBe("localhost");
      expect(url.pathname).toBe("/auth/callback");
      expect(Number(url.port)).toBeGreaterThan(0);

      const response = await fetch(`${url.toString()}?code=abc&state=expected-state`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("You may close this window");
      await expect(loopback.waitForCode()).resolves.toEqual({ code: "abc", state: "expected-state" });
    } finally {
      loopback.close();
    }
  });

  test("loopback rejects on state mismatch", async () => {
    const loopback = createLoopbackServer("expected-state", { port: 0 });

    try {
      const response = await fetch(`${loopback.redirectUri}?code=abc&state=wrong-state`);

      expect(response.status).toBe(400);
      await expect(loopback.waitForCode()).rejects.toBeInstanceOf(ChatGPTStateMismatchError);
    } finally {
      loopback.close();
    }
  });

  test("loopback rejects when abort signal fires", async () => {
    const loopback = createLoopbackServer("expected-state", { port: 0 });
    const controller = new AbortController();

    try {
      const wait = loopback.waitForCode(controller.signal);
      controller.abort();

      await expect(wait).rejects.toBeInstanceOf(ChatGPTOAuthAbortedError);
    } finally {
      loopback.close();
    }
  });

  test("loopback throws ChatGPTOAuthPortInUseError when Bun.serve fails", async () => {
    const first = createLoopbackServer("expected-state", { port: 0 });

    try {
      const port = Number(new URL(first.redirectUri).port);

      expect(() => createLoopbackServer("other-state", { port })).toThrow(ChatGPTOAuthPortInUseError);
    } finally {
      first.close();
    }
  });
});

function buildJwt(payload: Record<string, unknown>): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}
