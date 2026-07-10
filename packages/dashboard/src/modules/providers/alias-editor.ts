import type { AliasConfig } from "@aio-proxy/types";
import { normalizeAliasName, normalizeVariantKey } from "@aio-proxy/types";

export type ProviderAlias = Readonly<Record<string, AliasConfig>>;

export type AliasDraft = {
  readonly name: string;
  readonly model: string;
  readonly preserve: boolean;
};

export type AliasEditResult =
  | { readonly ok: true; readonly alias: ProviderAlias }
  | { readonly ok: false; readonly code: "alias-missing" | "name-duplicate" | "name-required" | "target-required" };

export type AliasEditorIssue = {
  readonly code:
    | "alias-name-duplicate"
    | "alias-name-required"
    | "preserved-route-conflict"
    | "target-missing"
    | "variant-name-duplicate"
    | "variant-name-required";
  readonly alias: string;
  readonly variant?: string;
};

export type AliasSummary = {
  readonly aliases: number;
  readonly variants: number;
};

export const aliasControlId = (alias: string, variant?: string): string =>
  variant === undefined
    ? `provider-alias-${encodeURIComponent(alias)}`
    : `provider-alias-${encodeURIComponent(alias)}-variant-${encodeURIComponent(variant)}`;

export const aliasIssueControlId = (issue: AliasEditorIssue): string => {
  const id = aliasControlId(issue.alias, issue.variant);
  return issue.code === "target-missing" ? `${id}-target` : id;
};

type VariantRename = {
  readonly alias: string;
  readonly variant: string;
  readonly name: string;
};

export function serializeAlias(alias: ProviderAlias, mode: "create" | "edit"): ProviderAlias | undefined {
  return Object.keys(alias).length === 0 && mode === "create" ? undefined : alias;
}

export function commitAliasDraft(alias: ProviderAlias, draft: AliasDraft): AliasEditResult {
  const name = normalizeAliasName(draft.name);
  const error = draftError(name, draft.model, Object.keys(alias).map(normalizeAliasName));
  if (error !== undefined) {
    return { ok: false, code: error };
  }

  return {
    ok: true,
    alias: { ...alias, [name]: { model: draft.model, preserve: draft.preserve } },
  };
}

export function renameAlias(alias: ProviderAlias, current: string, next: string): AliasEditResult {
  const config = alias[current];
  if (config === undefined) {
    return { ok: false, code: "alias-missing" };
  }

  const name = normalizeAliasName(next);
  const otherNames = Object.keys(alias)
    .filter((key) => key !== current)
    .map(normalizeAliasName);
  const error = draftError(name, config.model, otherNames);
  if (error !== undefined) {
    return { ok: false, code: error };
  }

  const renamed = Object.fromEntries(
    Object.entries(alias).map(([key, value]) => [key === current ? name : key, value]),
  );
  return { ok: true, alias: renamed };
}

export function commitVariantDraft(alias: ProviderAlias, aliasName: string, draft: AliasDraft): AliasEditResult {
  const config = alias[aliasName];
  if (config === undefined) {
    return { ok: false, code: "alias-missing" };
  }

  const name = normalizeVariantKey(draft.name);
  const error = draftError(name, draft.model, Object.keys(config.variants ?? {}).map(normalizeVariantKey));
  if (error !== undefined) {
    return { ok: false, code: error };
  }

  return {
    ok: true,
    alias: {
      ...alias,
      [aliasName]: {
        ...config,
        variants: { ...config.variants, [name]: { model: draft.model, preserve: draft.preserve } },
      },
    },
  };
}

export function renameVariant(alias: ProviderAlias, rename: VariantRename): AliasEditResult {
  const config = alias[rename.alias];
  const target = config?.variants?.[rename.variant];
  if (config === undefined || target === undefined) {
    return { ok: false, code: "alias-missing" };
  }

  const name = normalizeVariantKey(rename.name);
  const otherNames = Object.keys(config.variants ?? {})
    .filter((key) => key !== rename.variant)
    .map(normalizeVariantKey);
  const error = draftError(name, target.model, otherNames);
  if (error !== undefined) {
    return { ok: false, code: error };
  }

  const variants = Object.fromEntries(
    Object.entries(config.variants ?? {}).map(([key, value]) => [key === rename.variant ? name : key, value]),
  );
  return { ok: true, alias: { ...alias, [rename.alias]: { ...config, variants } } };
}

export function aliasSummary(alias: ProviderAlias): AliasSummary {
  let variants = 0;
  for (const config of Object.values(alias)) {
    variants += Object.keys(config.variants ?? {}).length;
  }
  return { aliases: Object.keys(alias).length, variants };
}

export function aliasTargetModels(alias: ProviderAlias): readonly string[] {
  return Array.from(new Set(Object.values(alias).flatMap(targetModels)));
}

export function preserveReferenceCount(alias: ProviderAlias, model: string): number {
  let count = 0;
  for (const config of Object.values(alias)) {
    if (config.preserve && config.model === model) {
      count += 1;
    }
    for (const target of Object.values(config.variants ?? {})) {
      if (target.preserve && target.model === model) {
        count += 1;
      }
    }
  }
  return count;
}

export function aliasEditorIssues(alias: ProviderAlias, models?: readonly string[]): readonly AliasEditorIssue[] {
  const issues: AliasEditorIssue[] = [];
  const availableModels = models === undefined ? undefined : new Set(models);
  const preservedModels = collectPreservedModels(alias);
  const aliasNames = new Set<string>();

  for (const [aliasName, config] of Object.entries(alias)) {
    const normalizedAlias = normalizeAliasName(aliasName);
    if (normalizedAlias === "") {
      issues.push({ code: "alias-name-required", alias: aliasName });
    } else if (aliasNames.has(normalizedAlias)) {
      issues.push({ code: "alias-name-duplicate", alias: aliasName });
    }
    aliasNames.add(normalizedAlias);

    if (preservedModels.has(normalizedAlias) && targetModels(config).some((model) => model !== normalizedAlias)) {
      issues.push({ code: "preserved-route-conflict", alias: aliasName });
    }
    if (availableModels !== undefined && !availableModels.has(config.model)) {
      issues.push({ code: "target-missing", alias: aliasName });
    }

    const variants = new Set<string>();
    for (const [variant, target] of Object.entries(config.variants ?? {})) {
      const normalizedVariant = normalizeVariantKey(variant);
      if (normalizedVariant === "") {
        issues.push({ code: "variant-name-required", alias: aliasName, variant });
      } else if (variants.has(normalizedVariant)) {
        issues.push({ code: "variant-name-duplicate", alias: aliasName, variant });
      }
      variants.add(normalizedVariant);
      if (availableModels !== undefined && !availableModels.has(target.model)) {
        issues.push({ code: "target-missing", alias: aliasName, variant });
      }
    }
  }

  return issues;
}

function draftError(
  name: string,
  model: string,
  existingNames: readonly string[],
): Extract<AliasEditResult, { readonly ok: false }>["code"] | undefined {
  if (name === "") {
    return "name-required";
  }
  if (model === "") {
    return "target-required";
  }
  return existingNames.includes(name) ? "name-duplicate" : undefined;
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
