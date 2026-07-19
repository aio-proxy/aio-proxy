import { antigravityFamilyForWireModel, antigravityFamilyWireModel } from "../catalog/families";

export type CcaThinkingConfig = {
  readonly thinkingBudget: number;
  readonly includeThoughts: boolean;
};

export type AntigravityThinkingOption =
  | { readonly mode: "disabled" }
  | { readonly mode: "fixed"; readonly budgetTokens: number }
  | { readonly mode: "adaptive"; readonly effort: string };

export class AntigravityThinkingError extends Error {
  override readonly name = "AntigravityThinkingError";
}

export function applyAntigravityThinking(modelId: string, thinking: AntigravityThinkingOption): CcaThinkingConfig {
  switch (thinking.mode) {
    case "disabled":
      return ccaConfig(0);
    case "fixed":
      if (!Number.isInteger(thinking.budgetTokens) || thinking.budgetTokens <= 0) {
        throw new AntigravityThinkingError("Invalid fixed thinking budget");
      }
      return ccaConfig(thinking.budgetTokens);
    case "adaptive":
      return ccaConfig(effortBudget(modelId, thinking.effort));
    default:
      throw new AntigravityThinkingError("Unsupported thinking mode");
  }
}

export function geminiThinkingConfig(
  modelId: string,
  thinkingConfig: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const thinkingLevel = Reflect.get(thinkingConfig, "thinkingLevel");
  if (typeof thinkingLevel !== "string") {
    throw new AntigravityThinkingError("Gemini thinkingLevel is required");
  }
  const effort = thinkingLevel.trim().toLowerCase();
  const { thinkingLevel: _removed, ...siblings } = thinkingConfig;
  return { ...siblings, ...ccaConfig(effortBudget(modelId, effort, "gemini")) };
}

function effortBudget(modelId: string, effort: string, mode?: "gemini"): number {
  const family = antigravityFamilyForWireModel(modelId);
  if (family === undefined || (mode !== undefined && family.thinking.mode !== mode)) {
    throw new AntigravityThinkingError(`No thinking family for ${modelId}`);
  }
  const budget = (family.thinking.effortBudgets as Readonly<Record<string, number>>)[effort];
  if (budget === undefined || antigravityFamilyWireModel(family, effort) !== modelId) {
    throw new AntigravityThinkingError(`Unsupported thinking effort ${effort} for ${modelId}`);
  }
  return budget;
}

function ccaConfig(thinkingBudget: number): CcaThinkingConfig {
  return { thinkingBudget, includeThoughts: thinkingBudget > 0 };
}
