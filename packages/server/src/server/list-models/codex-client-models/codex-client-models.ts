import { ModelContextAggregation, type CodexUpstreamModel, type ModelLimit } from '@aio-proxy/types';

import type { ServerState } from '../../../server-state';
import {
  type ResolvedModel,
  resolveEnabledModels,
  resolveModelCapabilities,
  resolveModelField,
} from '../../model-resolution/index';
import { assembleCodexModel, projectCodexMetadata, renderDefaultInstructions } from './codex-assembly';
import { readCodexModelsCache } from './codex-cache';

type Options = { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal };

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

type CodexWindows = {
  readonly contextWindow: number;
  readonly maxContextWindow: number;
};

const DEFAULT_CODEX_WINDOWS: CodexWindows = {
  contextWindow: 272_000,
  maxContextWindow: 272_000,
};

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

function projectGenericWindows(limit: ModelLimit | undefined): CodexWindows | undefined {
  const input = positiveInteger(limit?.input);
  const context = positiveInteger(limit?.context);
  if (input === undefined && context === undefined) return undefined;
  if (input !== undefined && context !== undefined && input > context) return undefined;
  return {
    contextWindow: input ?? context!,
    maxContextWindow: context ?? input!,
  };
}

function officialWindowOverrides(row: CodexUpstreamModel | undefined): Partial<CodexWindows> {
  if (row === undefined) return {};
  const context = positiveInteger(row['context_window']);
  const maximum = positiveInteger(row['max_context_window']);
  if (context !== undefined && maximum !== undefined && context > maximum) return {};
  return {
    ...(context === undefined ? {} : { contextWindow: context }),
    ...(maximum === undefined ? {} : { maxContextWindow: maximum }),
  };
}

function resolveCodexWindows(model: ResolvedModel, codexBySlug: ReadonlyMap<string, CodexUpstreamModel>): CodexWindows {
  const candidates = model.candidates.map((candidate): CodexWindows => {
    const configured = projectGenericWindows(candidate.configMetadata?.limit);
    if (configured !== undefined) return configured;

    const generic =
      projectGenericWindows(candidate.upstreamMetadata?.limit) ??
      projectGenericWindows(model.fallbackMetadata?.limit) ??
      DEFAULT_CODEX_WINDOWS;
    const official = officialWindowOverrides(codexBySlug.get(candidate.modelId));
    const overlaid = {
      contextWindow: official.contextWindow ?? generic.contextWindow,
      maxContextWindow: official.maxContextWindow ?? generic.maxContextWindow,
    };
    return overlaid.contextWindow <= overlaid.maxContextWindow ? overlaid : generic;
  });
  const aggregate = model.aggregation === ModelContextAggregation.Max ? Math.max : Math.min;
  const resolved = {
    contextWindow: aggregate(...candidates.map(({ contextWindow }) => contextWindow)),
    maxContextWindow: aggregate(...candidates.map(({ maxContextWindow }) => maxContextWindow)),
  };
  return resolved.contextWindow <= resolved.maxContextWindow ? resolved : DEFAULT_CODEX_WINDOWS;
}

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

// Every row in this catalog is a codex picker entry, and codex only ever calls a
// picked model as a text chat model. An image or video generator listed here is
// unselectable in practice: picking it fails the turn. The Codex ModelInfo shape
// has no output-modality field to describe one either, so the row cannot even be
// honest about what it is.
//
// Unknown output modality is hidden too. A model the metadata layers say nothing
// about is exactly the hand-listed api-provider id that image/video models arrive
// as, and a picker entry that always fails is worse than an absent one: the fix
// for a missing model is `router.models.<slug>.metadata`, while a broken entry
// has no user-side fix.
function servesCodexText(model: ResolvedModel): boolean {
  return resolveModelCapabilities(model)?.modalities?.output?.includes('text') === true;
}

export async function codexClientModels(
  state: ServerState,
  options: Options = {},
): Promise<{ readonly models: readonly Record<string, unknown>[] }> {
  const [enabled, upstream] = await Promise.all([resolveEnabledModels(state), readCodexModelsCache(options)]);
  const resolved = enabled.filter(servesCodexText);
  const bySlug = new Map(upstream.map((item) => [item.slug, item]));
  // Prefer gpt-5.5 as the synthesis template (matches CPA's default) so every
  // required Codex ModelInfo field is inherited; else any cached row; else
  // undefined (empty cache) and assembleCodexModel backstops with static defaults.
  const template = bySlug.get('gpt-5.5') ?? upstream[0];

  const templated: { entry: Record<string, unknown>; priority: number }[] = [];
  const synthesizedInputs: { slug: string; displayName: string; entry: Record<string, unknown> }[] = [];

  for (const model of resolved) {
    const primary = model.candidates[0]!;
    const windows = resolveCodexWindows(model, bySlug);
    const row = bySlug.get(model.modelId);
    if (row !== undefined) {
      const configPatch = projectCodexMetadata(primary.configMetadata, false);
      const entry: Record<string, unknown> = {
        ...projectCodexMetadata(undefined, true),
        ...projectCodexMetadata(model.fallbackMetadata, false),
        ...projectCodexMetadata(primary.upstreamMetadata, false),
        ...row,
        ...normalizeInstructions(row, model.slug),
        ...configPatch,
        slug: model.slug,
        id: model.slug,
        display_name:
          primary.configMetadata?.name ??
          row.display_name ??
          primary.upstreamMetadata?.name ??
          model.fallbackMetadata?.name ??
          model.slug,
        description:
          primary.configMetadata?.description ??
          row['description'] ??
          primary.upstreamMetadata?.description ??
          model.fallbackMetadata?.description ??
          '',
        context_window: windows.contextWindow,
        max_context_window: windows.maxContextWindow,
      };
      const levels = entry['supported_reasoning_levels'];
      if (Array.isArray(levels) && levels.length === 0) delete entry['default_reasoning_level'];
      templated.push({
        entry,
        priority: row.priority,
      });
      continue;
    }
    const capabilities = resolveModelCapabilities(model);
    const description = resolveModelField(model, (metadata) => metadata.description);
    const metadata =
      capabilities === undefined && description === undefined
        ? undefined
        : {
            ...(description === undefined ? {} : { description }),
            ...(capabilities === undefined ? {} : { capabilities }),
          };
    const displayName = resolveModelField(model, (metadata) => metadata.name) ?? model.slug;
    synthesizedInputs.push({
      slug: model.slug,
      displayName,
      entry: assembleCodexModel({
        slug: model.slug,
        displayName,
        metadata,
        contextWindow: windows.contextWindow,
        maxContextWindow: windows.maxContextWindow,
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
