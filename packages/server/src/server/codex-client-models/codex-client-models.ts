import type { ServerState } from '../../server-state';
import { resolveEnabledModels } from '../model-resolution/index';
import { assembleCodexModel } from './codex-assembly';
import { readCodexModelsCache } from './codex-cache';

type Options = { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal };

export async function codexClientModels(
  state: ServerState,
  options: Options = {},
): Promise<{ readonly models: readonly Record<string, unknown>[] }> {
  const [resolved, upstream] = await Promise.all([resolveEnabledModels(state), readCodexModelsCache(options)]);
  const bySlug = new Map(upstream.map((item) => [item.slug, item]));

  const templated: { entry: Record<string, unknown>; priority: number }[] = [];
  const synthesized: Record<string, unknown>[] = [];

  for (const model of resolved) {
    const row = bySlug.get(model.modelId);
    if (row !== undefined) {
      // Case A is verbatim: display_name comes from the upstream row, so it may
      // differ from the alias-only name that listModels/Case B derive. Intentional.
      templated.push({ entry: { ...row, slug: model.slug, id: model.slug }, priority: row.priority });
      continue;
    }
    synthesized.push(
      assembleCodexModel({
        slug: model.slug,
        displayName: model.displayName,
        metadata: model.metadata,
      }),
    );
  }

  templated.sort((a, b) => a.priority - b.priority);
  return { models: [...templated.map((t) => t.entry), ...synthesized] };
}
