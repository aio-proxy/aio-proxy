import type { ServerState } from '../../../server-state';
import { resolveEnabledModels } from '../../model-resolution/index';
import { assembleCodexModel } from './codex-assembly';
import { readCodexModelsCache } from './codex-cache';

type Options = { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal };

export async function codexClientModels(
  state: ServerState,
  options: Options = {},
): Promise<{ readonly models: readonly Record<string, unknown>[] }> {
  const [resolved, upstream] = await Promise.all([resolveEnabledModels(state), readCodexModelsCache(options)]);
  const bySlug = new Map(upstream.map((item) => [item.slug, item]));
  // Prefer gpt-5.5 as the synthesis template (matches CPA's default) so every
  // required Codex ModelInfo field is inherited; else any cached row; else
  // undefined (empty cache) and assembleCodexModel backstops with static defaults.
  const template = bySlug.get('gpt-5.5') ?? upstream[0];

  const templated: { entry: Record<string, unknown>; priority: number }[] = [];
  const synthesizedInputs: { slug: string; displayName: string; entry: Record<string, unknown> }[] = [];

  for (const model of resolved) {
    const row = bySlug.get(model.modelId);
    if (row !== undefined) {
      // Case A is verbatim: display_name comes from the upstream row, so it may
      // differ from the alias-only name that listModels/Case B derive. Intentional.
      // A config context override still wins over the row's advertised window.
      const contextOverride =
        model.contextWindow === undefined
          ? {}
          : { context_window: model.contextWindow, max_context_window: model.contextWindow };
      templated.push({
        entry: { ...row, ...contextOverride, slug: model.slug, id: model.slug },
        priority: row.priority,
      });
      continue;
    }
    synthesizedInputs.push({
      slug: model.slug,
      displayName: model.displayName,
      entry: assembleCodexModel({
        slug: model.slug,
        displayName: model.displayName,
        metadata: model.metadata,
        contextWindow: model.contextWindow,
        template,
      }),
    });
  }

  // Synthesized (Case B) entries share one placeholder priority, so give each a
  // stable rank instead (matches CPA): sort by display name then slug, then
  // assign basePriority + 100*(rank+1) past the largest template priority so
  // they sort deterministically and always after real Codex models.
  const basePriority = templated.reduce((max, t) => Math.max(max, t.priority), 0);
  const synthesized = [...synthesizedInputs]
    .sort((a, b) => {
      const byName = a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
      return byName !== 0 ? byName : a.slug.localeCompare(b.slug);
    })
    .map((input, rank) => ({ entry: input.entry, priority: basePriority + 100 * (rank + 1) }));

  for (const { entry, priority } of synthesized) entry['priority'] = priority;

  const all = [...templated, ...synthesized];
  all.sort((a, b) => a.priority - b.priority);
  return { models: all.map((item) => item.entry) };
}
