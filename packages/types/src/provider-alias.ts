import type { z } from "zod";
import type { AliasConfig } from "./common";
import { normalizeAliasName, normalizeVariantKey } from "./common";

export type ProviderAlias = Readonly<Record<string, AliasConfig>>;

type ProviderAliasTargets = {
  readonly models?: readonly string[] | undefined;
  readonly alias?: ProviderAlias | undefined;
};

type VariantValidation = {
  readonly alias: string;
  readonly models: ReadonlySet<string> | undefined;
  readonly ctx: z.RefinementCtx;
};

export function validateAliasTargets(provider: ProviderAliasTargets, ctx: z.RefinementCtx): void {
  if (provider.alias === undefined) {
    return;
  }

  validateAliasNames(provider.alias, ctx);
  const models = provider.models === undefined ? undefined : new Set(provider.models);
  const preservedModels = collectPreservedModels(provider.alias);

  for (const [alias, config] of Object.entries(provider.alias)) {
    if (models !== undefined && !models.has(config.model)) {
      ctx.addIssue({
        code: "custom",
        message: `Alias target "${config.model}" is not listed in models`,
        path: ["alias", alias, "model"],
      });
    }

    validateVariants(config, { alias, models, ctx });
    const clientModel = normalizeAliasName(alias);
    if (preservedModels.has(clientModel) && targetModels(config).some((model) => model !== clientModel)) {
      ctx.addIssue({
        code: "custom",
        message: `Alias "${clientModel}" conflicts with a preserved original model id`,
        path: ["alias", alias],
      });
    }
  }
}

function validateAliasNames(alias: ProviderAlias, ctx: z.RefinementCtx): void {
  const names = new Set<string>();
  for (const name of Object.keys(alias)) {
    const normalized = normalizeAliasName(name);
    if (normalized === "" || names.has(normalized)) {
      ctx.addIssue({
        code: "custom",
        message: normalized === "" ? "Alias name cannot be empty" : `Duplicate alias name "${normalized}"`,
        path: ["alias", name],
      });
    }
    names.add(normalized);
  }
}

function validateVariants(config: AliasConfig, { alias, models, ctx }: VariantValidation): void {
  const names = new Set<string>();
  for (const [variant, target] of Object.entries(config.variants ?? {})) {
    const normalized = normalizeVariantKey(variant);
    if (normalized === "" || names.has(normalized)) {
      ctx.addIssue({
        code: "custom",
        message: normalized === "" ? "Variant name cannot be empty" : `Duplicate variant name "${normalized}"`,
        path: ["alias", alias, "variants", variant],
      });
    }
    names.add(normalized);

    if (models !== undefined && !models.has(target.model)) {
      ctx.addIssue({
        code: "custom",
        message: `Alias variant target "${target.model}" is not listed in models`,
        path: ["alias", alias, "variants", variant, "model"],
      });
    }
  }
}

function collectPreservedModels(alias: ProviderAlias): ReadonlySet<string> {
  const models = new Set<string>();
  for (const config of Object.values(alias)) {
    if (config.preserve) {
      models.add(config.model);
    }
    for (const target of Object.values(config.variants ?? {})) {
      if (target.preserve) {
        models.add(target.model);
      }
    }
  }
  return models;
}

function targetModels(config: AliasConfig): readonly string[] {
  return [config.model, ...Object.values(config.variants ?? {}).map((target) => target.model)];
}
