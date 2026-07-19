import type { AccountContext, ModelCatalog, ModelDescriptor } from "@aio-proxy/plugin-sdk";
import { kimiIdentityHeaders } from "./headers";
import { currentKimiCredential, type KimiCredential, type KimiOAuthDependencies } from "./oauth";

export const KIMI_CATALOG_TTL_MS = 6 * 60 * 60_000;

const empty = (language: readonly ModelDescriptor[]): ModelCatalog => ({
  language,
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
});

export function staticKimiCatalog(): ModelCatalog {
  return empty([
    {
      id: "kimi-for-coding",
      displayName: "Kimi for Coding",
      metadata: { protocol: "openai-compatible" },
    },
  ]);
}

export async function discoverKimiCatalog(
  context: AccountContext<KimiCredential, Record<string, never>>,
  dependencies: KimiOAuthDependencies = {},
): Promise<ModelCatalog> {
  const credential = await currentKimiCredential(context.credentials, { ...dependencies, signal: context.signal });
  const response = await (dependencies.fetch ?? globalThis.fetch)("https://api.kimi.com/coding/v1/models", {
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      ...kimiIdentityHeaders(credential.deviceId),
    },
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`Kimi model catalog request failed with ${response.status}`);
  const root: unknown = await response.json();
  if (typeof root !== "object" || root === null || !Array.isArray(Reflect.get(root, "data"))) {
    throw new Error("Kimi model catalog response is invalid");
  }
  const language = Reflect.get(root, "data").flatMap((value: unknown): ModelDescriptor[] => {
    if (typeof value !== "object" || value === null) return [];
    const id = Reflect.get(value, "id");
    if (typeof id !== "string" || id.trim() === "") return [];
    const displayName = Reflect.get(value, "display_name");
    return [
      {
        id: id.trim(),
        ...(typeof displayName === "string" && displayName.trim() !== "" ? { displayName: displayName.trim() } : {}),
        metadata: {
          protocol: Reflect.get(value, "protocol") === "anthropic" ? "anthropic" : "openai-compatible",
        },
      },
    ];
  });
  return empty(language);
}
