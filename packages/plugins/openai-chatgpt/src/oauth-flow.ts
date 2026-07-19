import type { ZodType } from "@aio-proxy/plugin-sdk";

import type { ChatGPTCredential } from "./schema";

import { extractAccountId } from "./jwt";
import { refreshTokenResponseSchema, tokenResponseSchema } from "./schema";

const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token" as const;
const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback" as const;
declare const __AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__: string;
export const CHATGPT_CLIENT_ID = __AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__;
const REFRESH_SCOPE = "openid profile email" as const;
const DEFAULT_EXPIRES_IN_SECONDS = 3_600 as const;

type OpenAITokenResponse = {
  readonly access_token: string;
  readonly expires_in?: number | undefined;
  readonly id_token?: string | undefined;
  readonly refresh_token?: string | undefined;
};

export type ChatGPTTokenExchangeOptions = {
  readonly fetch?: ChatGPTFetch;
  readonly now?: () => number;
  readonly redirectUri?: string;
  readonly signal?: AbortSignal;
};

export type ChatGPTFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ChatGPTTokenExchangeError extends Error {
  override readonly name = "ChatGPTTokenExchangeError";

  constructor(readonly status: number) {
    super(`ChatGPT token exchange failed with status ${status}`);
  }
}

export class ChatGPTAccountIdMissingError extends Error {
  override readonly name = "ChatGPTAccountIdMissingError";

  constructor() {
    super("ChatGPT token response is missing chatgpt_account_id");
  }
}

export class ChatGPTRefreshTokenMissingError extends Error {
  override readonly name = "ChatGPTRefreshTokenMissingError";

  constructor() {
    super("ChatGPT token response is missing refresh_token");
  }
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  options: ChatGPTTokenExchangeOptions = {},
): Promise<ChatGPTCredential> {
  const body = await postTokenRequest(
    new URLSearchParams({
      client_id: CHATGPT_CLIENT_ID,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: options.redirectUri ?? DEFAULT_REDIRECT_URI,
    }),
    options,
    tokenResponseSchema,
  );

  return toCredential(body, options.now);
}

export async function refreshAccessToken(
  refreshToken: string,
  options: ChatGPTTokenExchangeOptions = {},
): Promise<ChatGPTCredential> {
  const body = await postTokenRequest(
    new URLSearchParams({
      client_id: CHATGPT_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: REFRESH_SCOPE,
    }),
    options,
    refreshTokenResponseSchema,
  );

  return toCredential(body, options.now, refreshToken);
}

async function postTokenRequest<T>(
  body: URLSearchParams,
  options: ChatGPTTokenExchangeOptions,
  schema: ZodType<T>,
): Promise<T> {
  const response = await (options.fetch ?? globalThis.fetch)(TOKEN_ENDPOINT, {
    body,
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok) throw new ChatGPTTokenExchangeError(response.status);
  return schema.parse(await response.json());
}

function toCredential(
  body: OpenAITokenResponse,
  now: (() => number) | undefined,
  fallbackRefreshToken?: string,
): ChatGPTCredential {
  const accountId =
    extractAccountId(body.access_token) ?? (body.id_token === undefined ? undefined : extractAccountId(body.id_token));
  if (accountId === undefined) throw new ChatGPTAccountIdMissingError();

  const refreshToken = body.refresh_token ?? fallbackRefreshToken;
  if (refreshToken === undefined) throw new ChatGPTRefreshTokenMissingError();

  return {
    accessToken: body.access_token,
    accountId,
    expiresAt: (now ?? Date.now)() + (body.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1_000,
    refreshToken,
  };
}
