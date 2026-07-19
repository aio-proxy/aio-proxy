import type { LogicalSessionSource } from "@aio-proxy/plugin-sdk";

export type SessionCandidate = {
  readonly source: Exclude<LogicalSessionSource, "previous-response" | "transcript" | "generated">;
  readonly value: string;
};

export type ProtocolSessionHints = {
  readonly candidates: readonly SessionCandidate[];
  readonly previousResponseId?: string;
  readonly transcript: unknown;
};

export type SelectSessionCandidateInput = {
  readonly protocol: readonly SessionCandidate[];
  readonly headers: Headers;
};

export const MAX_SESSION_VALUE_LENGTH = 512;

const headerCandidates = [
  ["header-session", "session_id"],
  ["header-session", "session-id"],
  ["header-session", "x-session-id"],
  ["header-conversation", "conversation_id"],
  ["header-conversation", "conversation-id"],
  ["header-conversation", "x-conversation-id"],
] as const satisfies readonly (readonly [SessionCandidate["source"], string])[];

export function normalizeSessionValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_SESSION_VALUE_LENGTH);
}

export function hashSession(namespace: string, value: string): `sha256:${string}` {
  const hash = new Bun.CryptoHasher("sha256").update(`${namespace}:${value}`).digest("hex");
  return `sha256:${hash}`;
}

export function selectSessionCandidate(input: SelectSessionCandidateInput): SessionCandidate | undefined {
  for (const candidate of input.protocol) {
    const selected = normalizedCandidate(candidate.source, candidate.value);
    if (selected !== undefined) return selected;
  }
  for (const [source, name] of headerCandidates) {
    const selected = normalizedCandidate(source, input.headers.get(name));
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function normalizedCandidate(source: SessionCandidate["source"], value: string | null): SessionCandidate | undefined {
  if (value === null) return undefined;
  const normalized = normalizeSessionValue(value);
  return normalized === undefined ? undefined : { source, value: normalized };
}
