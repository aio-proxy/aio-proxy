import type { ProviderV3, ProviderV4 } from "@ai-sdk/provider";

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

export type BundledAiSdkProviderPackage =
  (typeof BUNDLED_PROVIDER_PACKAGES)[number];

export type AiSdkProviderLoadOptions = {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly headers?: Record<string, string>;
  readonly name?: string;
};

export type LoadedAiSdkProvider = ProviderV3 | ProviderV4;

type AiSdkProviderLoader = (
  options?: AiSdkProviderLoadOptions,
) => Promise<LoadedAiSdkProvider>;

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
    if (options.baseURL === undefined || options.name === undefined) {
      throw new AiSdkProviderLoaderError(
        "@ai-sdk/openai-compatible requires name and baseURL",
      );
    }

    const { createOpenAICompatible } = await import(
      "@ai-sdk/openai-compatible"
    );

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

export const BUNDLED_PROVIDERS: Readonly<Record<string, AiSdkProviderLoader>> =
  bundledProviders;

export class AiSdkProviderLoaderError extends Error {
  override readonly name = "AiSdkProviderLoaderError";
}

export async function loadAiSdkProvider(
  packageName: string,
  options?: AiSdkProviderLoadOptions,
): Promise<LoadedAiSdkProvider | null> {
  const loader = BUNDLED_PROVIDERS[packageName];

  if (loader === undefined) {
    return null;
  }

  return loader(options);
}
