import type { AliasEditorIssue } from '../alias-editor';
import { apiConnectionIssues, type ApiEndpointDraft } from '../api-endpoints';
import { exposedModels, oauthEditorExposedModels } from '../exposed-models';
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
  readonly endpoints?: ApiEndpointDraft | undefined;
  readonly apiKey?: string | undefined;
  readonly hasApiKey?: boolean | undefined;
  readonly capabilityKey?: string | undefined;
  readonly authorized?: boolean | undefined;
  readonly packageName?: string | undefined;
  readonly models: readonly string[];
  readonly excludedModels?: readonly string[] | undefined;
  readonly discoveredModels?: readonly string[] | undefined;
  readonly aliasCount?: number | undefined;
  readonly aliasIssues: readonly AliasEditorIssue[];
  readonly transformsValid: boolean;
  readonly transformCount?: number | undefined;
  readonly weightTie: boolean;
  readonly enabled?: boolean | undefined;
  readonly priority?: number | undefined;
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
  if (
    input.kind === 'api' &&
    apiConnectionIssues(input.endpoints, { apiKey: input.apiKey ?? '', hasApiKey: input.hasApiKey === true }) !==
      undefined
  ) {
    connection = 'todo';
  }
  if (input.kind === 'oauth' && (input.capabilityKey ?? '') === '') connection = 'todo';
  // A blank package name fails AiSdkPackageNameSchema's min(1), so the save would come back a toast.
  if (input.kind === 'ai-sdk' && (input.optionsValid === false || blankPackageName(input.packageName))) {
    connection = 'todo';
  }
  // The one `attention` in the whole registry (X9), and it gates the save like any other non-ok status:
  // an unauthorized oauth draft has nothing to persist yet. The Connection section's own authorize
  // button is the way out, not the footer's primary.
  if (connection === 'ok' && input.kind === 'oauth' && input.authorized !== true) connection = 'attention';

  // Nothing exposed and no aliases means the provider would route nothing at all, so the save is
  // pointless: `modelRoutes` derives its routes from the whitelist plus the alias map. oauth is
  // exempt — its empty whitelist means "expose the whole upstream catalog", which stays true even
  // when the dashboard could not fetch that catalog (`catalog_unavailable`).
  const exposed =
    input.kind === 'oauth'
      ? oauthEditorExposedModels(input.discoveredModels, input.excludedModels)
      : exposedModels(input.models, input.discoveredModels);
  let models: SectionStatus =
    input.kind === 'oauth'
      ? input.discoveredModels !== undefined && exposed.length === 0 && (input.aliasCount ?? 0) === 0
        ? 'todo'
        : 'ok'
      : exposed.length === 0 && (input.aliasCount ?? 0) === 0
        ? 'todo'
        : 'ok';
  // A stale whitelist entry stays `ok` (X9): the upstream catalog is not the user's to fix, so gating
  // the save on it would strand them. `modelsHint` still names it — off the same inputs, not off this
  // status — so the reason survives on screen.
  // Last, so it outranks the exposure check above — an alias issue turns the save into a 400 through
  // validateAliasTargets, and the alias editor sits in this section (D-F6), so a provider that exposes
  // plenty of models still has unfinished work here.
  if (input.aliasIssues.length > 0) models = 'todo';

  // Always `ok` (X9): a weight tie is advice about ordering, not an unfinished field. `routingHint`
  // reads `weightTie` directly to keep saying so.
  const routing: SectionStatus = 'ok';

  const advanced: SectionStatus = input.transformsValid ? 'ok' : 'todo';

  return {
    identity: { status: identity, hint: identityHint(input, identity) },
    connection: { status: connection, hint: connectionHint(input, connection) },
    models: { status: models, hint: modelsHint(input, models) },
    routing: { status: routing, hint: routingHint(input) },
    advanced: { status: advanced, hint: advancedHint(input, advanced) },
  };
}

/**
 * Anything not `ok` gates the save (X9). `attention` is not a softer `todo` here — it is reserved for
 * the one state that genuinely cannot be persisted yet (an unauthorized oauth draft), so a section
 * that only has advice to give reports `ok` and puts the advice in its hint instead.
 */
export function blockingSections(summaries: Readonly<Record<SectionId, SectionSummary>>): SectionId[] {
  return SECTION_ORDER.filter((section) => summaries[section].status !== 'ok');
}
