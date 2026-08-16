import type { AliasEditorIssue } from '../alias-editor';
import { exposedModels } from '../exposed-models';
import { advancedHint, blankPackageName, connectionHint, identityHint, modelsHint, routingHint } from './section-hint';

export type SectionId = 'identity' | 'connection' | 'models' | 'routing' | 'advanced';
export type SectionStatus = 'todo' | 'attention' | 'ok';

/** A section's live status plus the finished, localized badge text that explains it. */
export interface SectionSummary {
  readonly status: SectionStatus;
  readonly hint: string;
}

export interface SectionStatusInput {
  readonly kind: 'api' | 'ai-sdk' | 'oauth';
  readonly mode: 'create' | 'edit';
  readonly id: string;
  readonly baseURL?: string | undefined;
  readonly protocol?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly capabilityKey?: string | undefined;
  readonly authorized?: boolean | undefined;
  readonly packageName?: string | undefined;
  readonly models: readonly string[];
  readonly discoveredModels?: readonly string[] | undefined;
  readonly aliasCount?: number | undefined;
  readonly aliasIssues: readonly AliasEditorIssue[];
  readonly transformsValid: boolean;
  readonly transformCount?: number | undefined;
  readonly weightTie: boolean;
  readonly enabled?: boolean | undefined;
  readonly weight?: number | undefined;
  readonly headerCount?: number | undefined;
  readonly proxyCustom?: boolean | undefined;
  readonly optionsValid?: boolean | undefined;
}

/**
 * The one section registry. Declared in rail order, so its keys double as the order every surface
 * lists sections in — and, unlike `Object.keys(summaries)`, that order cannot be reshuffled by
 * however a caller built its map. `satisfies` is the load-bearing part: it is what stops a sixth
 * `SectionId` from silently going unlisted in the nav, the footer, or the scroll observer.
 */
export const SECTION_LABEL = {
  identity: 'dashboard.providers.editor.section_identity',
  connection: 'dashboard.providers.editor.section_connection',
  models: 'dashboard.providers.editor.section_models',
  routing: 'dashboard.providers.editor.section_routing',
  advanced: 'dashboard.providers.editor.section_advanced',
} as const satisfies Record<SectionId, string>;

export const SECTION_ORDER = Object.keys(SECTION_LABEL) as readonly SectionId[];

export function sectionStatuses(input: SectionStatusInput): Readonly<Record<SectionId, SectionSummary>> {
  // The id is server-assigned for oauth creation, so it can never be a todo there.
  const identity: SectionStatus =
    input.mode === 'create' && input.kind !== 'oauth' && input.id.trim() === '' ? 'todo' : 'ok';

  let connection: SectionStatus = 'ok';
  if (input.kind === 'api' && ((input.baseURL ?? '').trim() === '' || (input.protocol ?? '') === '')) {
    connection = 'todo';
  }
  if (input.kind === 'oauth' && (input.capabilityKey ?? '') === '') connection = 'todo';
  // A blank package name fails AiSdkPackageNameSchema's min(1), so the save would come back a toast.
  if (input.kind === 'ai-sdk' && (input.optionsValid === false || blankPackageName(input.packageName))) {
    connection = 'todo';
  }
  // Attention, never todo: an unauthorized oauth draft is saved BY authorizing, and an empty apiKey
  // in edit mode means "keep the stored key" (D-F2).
  if (connection === 'ok' && input.kind === 'oauth' && input.authorized !== true) connection = 'attention';
  if (connection === 'ok' && input.kind === 'api' && input.mode === 'create' && (input.apiKey ?? '').trim() === '') {
    connection = 'attention';
  }

  // Nothing exposed and no aliases means the provider would route nothing at all, so the save is
  // pointless: `modelRoutes` derives its routes from the whitelist plus the alias map. oauth is
  // exempt — its empty whitelist means "expose the whole upstream catalog", which stays true even
  // when the dashboard could not fetch that catalog (`catalog_unavailable`).
  const exposed = exposedModels(input.models, input.discoveredModels);
  let models: SectionStatus =
    input.kind !== 'oauth' && exposed.length === 0 && (input.aliasCount ?? 0) === 0 ? 'todo' : 'ok';
  if (input.discoveredModels !== undefined && input.models.length > 0) {
    const discovered = new Set(input.discoveredModels);
    if (input.models.some((model) => !discovered.has(model))) models = 'attention';
  }

  // Alias issues block: validateAliasTargets turns them into a 400 on save.
  let routing: SectionStatus = input.aliasIssues.length > 0 ? 'todo' : 'ok';
  if (routing === 'ok' && input.weightTie) routing = 'attention';

  const advanced: SectionStatus = input.transformsValid ? 'ok' : 'todo';

  return {
    identity: { status: identity, hint: identityHint(input, identity) },
    connection: { status: connection, hint: connectionHint(input, connection) },
    models: { status: models, hint: modelsHint(input, models) },
    routing: { status: routing, hint: routingHint(input, routing) },
    advanced: { status: advanced, hint: advancedHint(input, advanced) },
  };
}

/** Save gating stays on `todo` alone: `attention` is informational (D-F2). */
export function blockingSections(summaries: Readonly<Record<SectionId, SectionSummary>>): SectionId[] {
  return SECTION_ORDER.filter((section) => summaries[section].status === 'todo');
}
