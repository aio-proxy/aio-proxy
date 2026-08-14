/** Empty whitelist means “expose the discovered catalog”, matching alias `targetOptions`. */
export const exposedModels = (
  models: readonly string[],
  candidates: readonly string[] | undefined,
): readonly string[] => (models.length === 0 ? (candidates ?? []) : models);
