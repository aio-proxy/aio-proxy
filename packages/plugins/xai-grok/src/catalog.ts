import type { AccountContext, ModelCatalog } from "@aio-proxy/plugin-sdk";
import { currentXAIGrokCredential, type XAIGrokOAuthOptions } from "./oauth";
import type { XAIGrokCredential } from "./schema";

export const XAI_GROK_CATALOG_TTL_MS = 6 * 60 * 60_000;
const MODELS_URL = "https://api.x.ai/v1/models";
const NON_CHAT_PREFIXES = ["grok-imagine-", "grok-stt-", "grok-voice-"] as const;
const CURATED = [
  ["grok-build", "Grok Build"],
  ["grok-build-0.1", "Grok Build 0.1"],
  ["grok-4.3", "Grok 4.3"],
  ["grok-4.5", "Grok 4.5"],
  ["grok-4.20-multi-agent-0309", "Grok 4.20 (Multi-Agent)"],
  ["grok-4.20-0309-reasoning", "Grok 4.20 (Reasoning)"],
  ["grok-4.20-0309-non-reasoning", "Grok 4.20 (Non-Reasoning)"],
  ["grok-composer-2.5-fast", "Grok Composer 2.5 Fast"],
] as const;
const curatedNames = new Map<string, string>(CURATED);

export class XAIGrokCatalogError extends Error {
  override readonly name = "XAIGrokCatalogError";

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function discoverXAIGrokModels(
  context: AccountContext<XAIGrokCredential, Record<string, never>>,
  options: XAIGrokOAuthOptions = {},
): Promise<ModelCatalog> {
  const credential = await currentXAIGrokCredential(context.credentials, { ...options, signal: context.signal });
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(MODELS_URL, {
      headers: { accept: "application/json", authorization: `Bearer ${credential.accessToken}` },
      signal: context.signal,
    });
  } catch {
    if (context.signal.aborted) throw context.signal.reason;
    throw new XAIGrokCatalogError("xAI model discovery network failure", true);
  }
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  if (!response.ok) throw new XAIGrokCatalogError("xAI model discovery rejected", retryable, response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new XAIGrokCatalogError("xAI model discovery returned invalid JSON", true);
  }
  const data = readData(payload);
  const byId = new Map<string, ModelCatalog["language"][number]>();
  for (const value of data) {
    if (typeof value !== "object" || value === null) continue;
    const rawId = Reflect.get(value, "id");
    if (typeof rawId !== "string") continue;
    const id = rawId.trim();
    if (!id.startsWith("grok-") || NON_CHAT_PREFIXES.some((prefix) => id.startsWith(prefix))) continue;
    const name = Reflect.get(value, "name");
    const displayName = curatedNames.get(id) ?? readDisplayName(name);
    byId.set(id, { id, ...(displayName === undefined ? {} : { displayName }) });
  }
  return emptyCatalog([...byId.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

export function initialXAIGrokCatalogFallback(error: unknown): ModelCatalog | undefined {
  return error instanceof XAIGrokCatalogError && error.retryable
    ? emptyCatalog(CURATED.map(([id, displayName]) => ({ id, displayName })))
    : undefined;
}

function readData(payload: unknown): readonly unknown[] {
  if (typeof payload !== "object" || payload === null) {
    throw new XAIGrokCatalogError("xAI model discovery returned invalid data", true);
  }
  const data = Reflect.get(payload, "data");
  if (!Array.isArray(data)) throw new XAIGrokCatalogError("xAI model discovery returned invalid data", true);
  return data;
}

function readDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const displayName = value.trim();
  return displayName === "" ? undefined : displayName;
}

function emptyCatalog(language: ModelCatalog["language"]): ModelCatalog {
  return { language, image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}
