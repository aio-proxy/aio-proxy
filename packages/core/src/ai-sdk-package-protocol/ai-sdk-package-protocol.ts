import { ProviderProtocol } from '@aio-proxy/types';

/**
 * The primary wire protocol an `ai-sdk` provider package speaks, or `undefined` when the package
 * serves several capabilities and must not be pinned to one.
 *
 * Only map single-capability packages. A multi-capability package such as `@ai-sdk/gateway`
 * (language, image, embedding, and evaluation) must stay unclassified: a pinned primary protocol
 * that does not serve language makes `synthesizesLanguage` return false, which would silently drop
 * chat through that provider.
 */
export function aiSdkPackagePrimaryProtocol(packageName: string): ProviderProtocol | undefined {
  switch (packageName) {
    case '@ai-sdk/openai':
      return ProviderProtocol.OpenAIResponse;
    case '@ai-sdk/openai-compatible':
      return ProviderProtocol.OpenAICompatible;
    case '@ai-sdk/anthropic':
      return ProviderProtocol.Anthropic;
    case '@ai-sdk/google':
      return ProviderProtocol.Gemini;
    case '@ai-sdk/typesafe-ai':
      return ProviderProtocol.TypeSafeSystemOne;
    default:
      return undefined;
  }
}
