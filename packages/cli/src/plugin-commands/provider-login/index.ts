import { loginOAuthAccount, recoverPendingAccountOperations } from "@aio-proxy/core";
import { getLocale } from "@aio-proxy/i18n";
import { LocalizedTextSchema, resolveLocalizedText } from "@aio-proxy/plugin-sdk";

import { canonical, chooseCapability, targetCapability } from "./capability";
import { createProviderLoginDefaultDeps, type ProviderLoginDeps } from "./deps";
import { ProviderCapabilityMismatchError, ProviderCapabilityNotFoundError } from "./errors";
import { presentProviderLoginUserError } from "./presentation";

export { createCapabilitySelector, createManualOnlyConfirmation } from "./capability";
export { createProviderLoginDefaultDeps, type ProviderLoginDefaultDepsOptions, type ProviderLoginDeps } from "./deps";
export * from "./errors";
export { isProviderLoginUserError } from "./presentation";

export type ProviderLoginOptions = { readonly provider?: string };

export async function providerLogin(
  capabilityInput: string | undefined,
  options: ProviderLoginOptions,
  injected?: ProviderLoginDeps,
): Promise<void> {
  const deps = injected ?? (await createProviderLoginDefaultDeps());
  try {
    await (deps.recover ?? recoverPendingAccountOperations)(deps.config, deps.repository, { mode: "cli" });
    const target = options.provider === undefined ? undefined : await targetCapability(options.provider, deps.config);
    if (target !== undefined && deps.registry.resolveOAuth(target.plugin, target.capability) === undefined) {
      throw new ProviderCapabilityNotFoundError(canonical(target));
    }
    const resolved =
      capabilityInput === undefined && target !== undefined
        ? target
        : await chooseCapability(capabilityInput, deps.registry, deps);
    if (target !== undefined && (target.plugin !== resolved.plugin || target.capability !== resolved.capability)) {
      throw new ProviderCapabilityMismatchError(canonical(resolved), canonical(target));
    }
    const result = await (deps.login ?? loginOAuthAccount)({
      ...(options.provider === undefined ? {} : { targetProviderId: options.provider }),
      capability: resolved,
      registry: deps.registry,
      repository: deps.repository,
      config: deps.config,
      renderAccountOptions: deps.renderAccountOptions,
      createAuthorization: deps.createAuthorization,
      diagnostics: deps.diagnostics,
      logger: deps.logger,
      progress: (message) => {
        const parsed = LocalizedTextSchema.safeParse(message);
        if (parsed.success) deps.print(resolveLocalizedText(parsed.data, getLocale()));
      },
    });
    deps.print(result.providerId);
  } catch (error) {
    throw presentProviderLoginUserError(error) ?? error;
  } finally {
    if (injected === undefined) deps.close?.();
  }
}
