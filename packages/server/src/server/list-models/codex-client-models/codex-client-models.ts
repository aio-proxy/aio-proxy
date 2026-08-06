import type { ServerState } from '../../../server-state';
import { resolveEnabledModels } from '../../model-resolution/index';
import { assembleCodexModel, renderDefaultInstructions } from './codex-assembly';
import { readCodexModelsCache } from './codex-cache';

type Options = { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal };

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

// Codex client 0.146.0 imposes two constraints on each /v1/models row:
//   1. base_instructions is a required String; a row missing it fails the whole
//      `Vec<ModelInfo>` deserialization and empties the picker.
//   2. At runtime the client prefers model_messages.instructions_template
//      whenever the key is present (even when empty), and only falls back to
//      base_instructions when the template is absent. A missing Option key
//      deserializes to None, so an absent template is fine, but a present empty
//      one would be used verbatim and yield an empty prompt.
// Upstream gpt-5.6-* rows omit base_instructions and carry the prompt under
// instructions_template. Resolve one non-empty text (existing template, else
// base_instructions, else the bundled default) and write it back so both the
// required field and the runtime-preferred field are non-empty. model_messages
// is cloned before edit so the shared cache object is never mutated.
function normalizeInstructions(row: Record<string, unknown>, slug: string): Record<string, unknown> {
  const messages = row['model_messages'];
  const hasMessages = typeof messages === 'object' && messages !== null;
  const template = hasMessages ? (messages as { instructions_template?: unknown })['instructions_template'] : undefined;
  const resolved = nonEmpty(template) ?? nonEmpty(row['base_instructions']) ?? renderDefaultInstructions(slug);

  const patch: Record<string, unknown> = { base_instructions: resolved };
  // Only rewrite the template when the client would otherwise read an empty one;
  // an absent template is left absent so the client keeps falling back to base.
  if (hasMessages && 'instructions_template' in (messages as object) && nonEmpty(template) === undefined) {
    patch['model_messages'] = { ...(messages as object), instructions_template: resolved };
  }
  return patch;
}

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
        entry: {
          ...row,
          ...normalizeInstructions(row, model.slug),
          ...contextOverride,
          slug: model.slug,
          id: model.slug,
        },
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
        metadata: model.effectiveMetadata,
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
