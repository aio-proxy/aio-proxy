import type { Config } from "@aio-proxy/types";
import { Hono } from "hono";

const OPENAI_SECRET_PATTERN = /^sk-[A-Za-z0-9_-]{20,}$/;
const BEARER_SECRET_PATTERN = /^Bearer\s+.+$/i;
const API_KEY_TEXT_PATTERN = /("?apiKey"?\s*:\s*")[^"]*(")/gi;

const maskSecret = (key: string, value: string): string => {
  if (OPENAI_SECRET_PATTERN.test(value)) {
    return "sk-****";
  }

  if (BEARER_SECRET_PATTERN.test(value)) {
    return "Bearer ****";
  }

  if (key.toLowerCase() === "apikey") {
    return "****";
  }

  return value.replace(API_KEY_TEXT_PATTERN, "$1****$2");
};

export const redactSecrets = (value: unknown, key = ""): unknown => {
  if (typeof value === "string") {
    return maskSecret(key, value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSecrets(entryValue, entryKey),
      ]),
    );
  }

  return value;
};

export const createDashboardRoutes = (config: Config) =>
  new Hono().get("/config", (context) => context.json(redactSecrets(config)));
