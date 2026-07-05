import { AiSdkProviderError, ProviderNotInstalledError } from "@aio-proxy/core";

export async function ensureAiSdkProviderAvailable(provider: {
  readonly ensureAvailable?: () => Promise<void>;
}): Promise<void> {
  if (provider.ensureAvailable !== undefined) {
    await provider.ensureAvailable();
  }
}

export function providerNotInstalled(error: unknown): ProviderNotInstalledError | undefined {
  if (error instanceof ProviderNotInstalledError) {
    return error;
  }

  if (error instanceof AiSdkProviderError && error.cause instanceof ProviderNotInstalledError) {
    return error.cause;
  }

  return undefined;
}
