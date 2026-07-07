import { z } from "zod";

import { extractAccountId } from "./jwt";
import { tokenResponseSchema } from "./schema";

const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token" as const;
const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback" as const;
const CLIENT_ID = "Iv1.b507a08c87ecfe98" as const;
const DEFAULT_EXPIRES_IN_SECONDS = 3_600 as const;
const refreshTokenResponseSchema = tokenResponseSchema.extend({
  refresh_token: z.string().optional(),
});

type OpenAiTokenResponse = {
  readonly access_token: string;
  readonly expires_in?: number | undefined;
  readonly id_token?: string | undefined;
  readonly refresh_token?: string | undefined;
};

export type ChatGPTTokenResult = {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId: string;
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

  constructor(
    readonly status: number,
    readonly responseText?: string,
  ) {
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
): Promise<ChatGPTTokenResult> {
  const body = await postTokenRequest(
    new URLSearchParams({
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: options.redirectUri ?? DEFAULT_REDIRECT_URI,
    }),
    options,
    tokenResponseSchema,
  );

  return toTokenResult(body, options.now);
}

export async function refreshAccessToken(
  refreshToken: string,
  options: ChatGPTTokenExchangeOptions = {},
): Promise<ChatGPTTokenResult> {
  const body = await postTokenRequest(
    new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    options,
    refreshTokenResponseSchema,
  );

  return toTokenResult(body, options.now, refreshToken);
}

async function postTokenRequest<TSchema extends z.ZodTypeAny>(
  body: URLSearchParams,
  options: ChatGPTTokenExchangeOptions,
  schema: TSchema,
): Promise<z.output<TSchema>> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher(TOKEN_ENDPOINT, {
    body,
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok) {
    throw new ChatGPTTokenExchangeError(response.status, await response.text());
  }

  return schema.parse(await response.json());
}

function toTokenResult(
  body: OpenAiTokenResponse,
  now: (() => number) | undefined,
  fallbackRefreshToken?: string,
): ChatGPTTokenResult {
  const accountId =
    extractAccountId(body.access_token) ?? (body.id_token === undefined ? undefined : extractAccountId(body.id_token));
  if (accountId === undefined) {
    throw new ChatGPTAccountIdMissingError();
  }

  return {
    access: body.access_token,
    accountId,
    expires: (now ?? Date.now)() + (body.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1_000,
    refresh: resolveRefreshToken(body, fallbackRefreshToken),
  };
}

function resolveRefreshToken(body: OpenAiTokenResponse, fallbackRefreshToken: string | undefined): string {
  const refreshToken = body.refresh_token ?? fallbackRefreshToken;
  if (refreshToken === undefined) {
    throw new ChatGPTRefreshTokenMissingError();
  }

  return refreshToken;
}
