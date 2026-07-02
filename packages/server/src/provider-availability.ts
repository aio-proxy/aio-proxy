import { AiSdkProviderError, ProviderNotInstalledError } from "@aio-proxy/core";
import type { ProviderKind } from "@aio-proxy/types";
import type { RuntimeProviderInstance } from "./runtime";

type AiSdkRuntimeProvider = Extract<
  RuntimeProviderInstance,
  { kind: ProviderKind.AiSdk }
>;

export async function ensureAiSdkProviderAvailable(
  provider: AiSdkRuntimeProvider,
): Promise<void> {
  if (provider.ensureAvailable !== undefined) {
    await provider.ensureAvailable();
  }
}

export function providerNotInstalled(
  error: unknown,
): ProviderNotInstalledError | undefined {
  if (error instanceof ProviderNotInstalledError) {
    return error;
  }

  if (
    error instanceof AiSdkProviderError &&
    error.cause instanceof ProviderNotInstalledError
  ) {
    return error.cause;
  }

  return undefined;
}
