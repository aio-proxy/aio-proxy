import { zod } from "@aio-proxy/plugin-sdk";

export type GoogleAntigravityAccountOptions = { readonly baseURL?: string };

export type GoogleAntigravityCredential = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly email: string;
  readonly projectId: string;
  readonly tokenType?: string;
  readonly scope?: string;
};

export function normalizeBaseURL(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("baseURL must use HTTP(S)");
  if (url.search !== "" || url.hash !== "") throw new Error("baseURL must not include a query or fragment");
  return url.toString().replace(/\/+$/u, "");
}

export const accountOptionsSchema = zod
  .object({ baseURL: zod.string().optional() })
  .transform(({ baseURL }): GoogleAntigravityAccountOptions => {
    const normalized = normalizeBaseURL(baseURL);
    return normalized === undefined ? {} : { baseURL: normalized };
  });

export const credentialSchema = zod
  .object({
    accessToken: zod.string().min(1),
    refreshToken: zod.string().min(1),
    expiresAt: zod.number(),
    email: zod.string().email(),
    projectId: zod.string().min(1),
    tokenType: zod.string().optional(),
    scope: zod.string().optional(),
  })
  .transform(
    ({ tokenType, scope, ...credential }): GoogleAntigravityCredential => ({
      ...credential,
      ...(tokenType === undefined ? {} : { tokenType }),
      ...(scope === undefined ? {} : { scope }),
    }),
  );
