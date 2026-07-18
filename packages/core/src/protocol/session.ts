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

export function transcriptFingerprint(transcript: unknown): `sha256:${string}` | undefined {
  if (
    transcript === undefined ||
    transcript === null ||
    (typeof transcript === "string" && transcript.trim() === "") ||
    (Array.isArray(transcript) && transcript.length === 0)
  ) {
    return undefined;
  }
  const serialized = JSON.stringify(sortJson(stableTranscriptPrefix(transcript)));
  return serialized === undefined ? undefined : hashSession("transcript", serialized);
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

function stableTranscriptPrefix(transcript: unknown): unknown {
  if (!Array.isArray(transcript)) return transcript;
  const prefix: unknown[] = [];
  for (const message of transcript) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
    const role = (message as { readonly role?: unknown }).role;
    if (role === "system" || role === "developer") prefix.push(message);
    if (role === "user") {
      prefix.push(message);
      break;
    }
  }
  return prefix.length === 0 ? transcript.slice(0, 1) : prefix;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
