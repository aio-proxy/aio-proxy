import { pathToFileURL } from "node:url";
import type { LoadedAiSdkRuntimeProvider } from "../ai-sdk-bridge";
import { AiSdkProviderLoaderError } from "../error";
import { findInstalledNpmPackage } from "../npm";

export const BUNDLED_PROVIDER_PACKAGES = [
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/google",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/mistral",
  "@ai-sdk/groq",
  "@ai-sdk/xai",
  "@openrouter/ai-sdk-provider",
] as const;

export type BundledAiSdkProviderPackage = (typeof BUNDLED_PROVIDER_PACKAGES)[number];

export type AiSdkProviderLoadOptions = {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly headers?: Record<string, string>;
  readonly name?: string;
  readonly [key: string]: unknown;
};

export type LoadedAiSdkProvider = LoadedAiSdkRuntimeProvider;

type AiSdkProviderLoader = (options?: AiSdkProviderLoadOptions) => Promise<LoadedAiSdkProvider>;

const bundledProviders = {
  "@ai-sdk/openai": async (options) => {
    const { createOpenAI } = await import("@ai-sdk/openai");

    return createOpenAI(options);
  },
  "@ai-sdk/anthropic": async (options) => {
    const { createAnthropic } = await import("@ai-sdk/anthropic");

    return createAnthropic(options);
  },
  "@ai-sdk/google": async (options) => {
    const { createGoogle } = await import("@ai-sdk/google");

    return createGoogle(options);
  },
  "@ai-sdk/openai-compatible": async (options = {}) => {
    if (typeof options.baseURL !== "string" || typeof options.name !== "string") {
      throw new AiSdkProviderLoaderError("@ai-sdk/openai-compatible requires name and baseURL");
    }

    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");

    return createOpenAICompatible({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      baseURL: options.baseURL,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      name: options.name,
    });
  },
  "@ai-sdk/mistral": async (options) => {
    const { createMistral } = await import("@ai-sdk/mistral");

    return createMistral(options);
  },
  "@ai-sdk/groq": async (options) => {
    const { createGroq } = await import("@ai-sdk/groq");

    return createGroq(options);
  },
  "@ai-sdk/xai": async (options) => {
    const { createXai } = await import("@ai-sdk/xai");

    return createXai(options);
  },
  "@openrouter/ai-sdk-provider": async (options) => {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");

    return createOpenRouter(options);
  },
} satisfies Record<BundledAiSdkProviderPackage, AiSdkProviderLoader>;

export const BUNDLED_PROVIDERS: Readonly<Record<string, AiSdkProviderLoader>> = bundledProviders;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderLoader(value: unknown): value is AiSdkProviderLoader {
  return typeof value === "function";
}

async function loadCachedProvider(
  packageName: string,
  options?: AiSdkProviderLoadOptions,
): Promise<LoadedAiSdkProvider | null> {
  const cached = await findInstalledNpmPackage(packageName);
  if (cached === null) {
    return null;
  }
  const loaded: unknown = await import(pathToFileURL(cached.entrypoint).href);
  if (!isRecord(loaded)) {
    throw new AiSdkProviderLoaderError(`No exports found in ${packageName}`);
  }
  for (const [name, value] of Object.entries(loaded)) {
    if (name.startsWith("create") && isProviderLoader(value)) {
      return value(options);
    }
  }
  throw new AiSdkProviderLoaderError(`No create* export found in ${packageName}`);
}

export async function loadAiSdkProvider(
  packageName: string,
  options?: AiSdkProviderLoadOptions,
): Promise<LoadedAiSdkProvider | null> {
  const loader = BUNDLED_PROVIDERS[packageName];

  if (loader === undefined) {
    return loadCachedProvider(packageName, options);
  }

  return loader(options);
}
