import type { AliasEditorIssue } from '../alias-editor';
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

const SECTION_ORDER: readonly SectionId[] = ['identity', 'connection', 'models', 'routing', 'advanced'];

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

  let models: SectionStatus = 'ok';
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
    advanced: { status: advanced, hint: advancedHint(input) },
  };
}

/** Save gating stays on `todo` alone: `attention` is informational (D-F2). */
export function blockingSections(summaries: Readonly<Record<SectionId, SectionSummary>>): SectionId[] {
  return SECTION_ORDER.filter((section) => summaries[section].status === 'todo');
}
