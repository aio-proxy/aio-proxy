import { AuthPayloadParseError, AuthPayloadSerializationError } from "./errors";

export function serializePayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new AuthPayloadSerializationError();
  }
  return serialized;
}

export function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AuthPayloadParseError(error);
    }
    throw error;
  }
}

export function readAccountLabel(payload: unknown): string | null {
  if (typeof payload === "object" && payload !== null && "account" in payload) {
    return typeof payload.account === "string" ? payload.account : null;
  }
  return null;
}

export function readExpiresAt(payload: unknown): number | null {
  if (typeof payload === "object" && payload !== null && "expiresAt" in payload) {
    return typeof payload.expiresAt === "number" ? payload.expiresAt : null;
  }
  return null;
}

export function hasToken(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  if ("access_token" in payload && typeof payload.access_token === "string") {
    return payload.access_token.length > 0;
  }
  if ("accessToken" in payload && typeof payload.accessToken === "string") {
    return payload.accessToken.length > 0;
  }
  return "token" in payload && typeof payload.token === "string" && payload.token.length > 0;
}
