export const ANTIGRAVITY_FAMILIES = [
  {
    logicalId: "gemini-3.5-flash",
    base: "gemini-3.5-flash-extra-low",
    variants: {
      minimal: "gemini-3.5-flash-extra-low",
      low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
    },
    thinking: { mode: "gemini", effortBudgets: { off: 0, minimal: 1000, low: 1000, medium: 4000, high: 10000 } },
  },
  {
    logicalId: "gemini-3.1-pro",
    base: "gemini-3.1-pro-low",
    retired: ["gemini-3.1-pro-high"],
    variants: { low: "gemini-3.1-pro-low", high: "gemini-pro-agent" },
    thinking: { mode: "gemini", effortBudgets: { off: 0, low: 1001, high: 10001 } },
  },
  {
    logicalId: "claude-sonnet-4-6",
    base: "claude-sonnet-4-6",
    variants: { high: "claude-sonnet-4-6", max: "claude-sonnet-4-6" },
    thinking: { mode: "claude", effortBudgets: { low: 4096, medium: 8192, high: 16384, max: 32768 } },
  },
  {
    logicalId: "claude-opus-4-6",
    base: "claude-opus-4-6-thinking",
    variants: { high: "claude-opus-4-6-thinking", max: "claude-opus-4-6-thinking" },
    thinking: { mode: "claude", effortBudgets: { low: 4096, medium: 8192, high: 16384, max: 32768 } },
  },
] as const;

export type AntigravityFamily = (typeof ANTIGRAVITY_FAMILIES)[number];

export function antigravityFamilyForWireModel(modelId: string): AntigravityFamily | undefined {
  return ANTIGRAVITY_FAMILIES.find((family) => {
    const variants: readonly string[] = Object.values(family.variants);
    return family.base === modelId || variants.includes(modelId);
  });
}

export function antigravityFamilyWireModel(family: AntigravityFamily, effort: string): string {
  return (family.variants as Readonly<Record<string, string>>)[effort] ?? family.base;
}

export type AntigravityWireProfile = Readonly<{
  modelEnum?: string;
  maxOutputTokens: number;
}>;

const wireProfiles: Readonly<Record<string, AntigravityWireProfile>> = {
  "gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65_536 },
  "gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65_536 },
  "gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65_536 },
  "gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65_535 },
  "gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65_535 },
  "claude-sonnet-4-6": { maxOutputTokens: 64_000 },
  "claude-opus-4-6-thinking": { maxOutputTokens: 64_000 },
};

export const ANTIGRAVITY_RETIRED_MODEL_IDS: ReadonlySet<string> = new Set<string>(
  ANTIGRAVITY_FAMILIES.flatMap((family) => ("retired" in family ? family.retired : [])),
);

export function modelCapabilities(modelId: string): AntigravityWireProfile | undefined {
  const profile = wireProfiles[modelId];
  return profile === undefined ? undefined : { ...profile };
}
