import { oauthExposedModels } from '@aio-proxy/types';

/** Empty whitelist means “expose the discovered catalog” at runtime. */
export const exposedModels = (
  models: readonly string[],
  candidates: readonly string[] | undefined,
): readonly string[] => (models.length === 0 ? (candidates ?? []) : models);

/** OAuth inverts the allowlist: every catalog id is exposed unless the draft hid it. */
export const oauthEditorExposedModels = (
  catalog: readonly string[] | undefined,
  excludedModels: readonly string[] | undefined,
): readonly string[] => oauthExposedModels(catalog ?? [], excludedModels);
