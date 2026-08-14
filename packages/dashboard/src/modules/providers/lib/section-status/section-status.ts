import type { AliasEditorIssue } from '../alias-editor';

export type SectionId = 'identity' | 'connection' | 'models' | 'routing' | 'advanced';
export type SectionStatus = 'todo' | 'attention' | 'ok';

export interface SectionStatusInput {
  readonly kind: 'api' | 'ai-sdk' | 'oauth';
  readonly mode: 'create' | 'edit';
  readonly id: string;
  readonly baseURL?: string | undefined;
  readonly protocol?: string | undefined;
  readonly capabilityKey?: string | undefined;
  readonly models: readonly string[];
  readonly discoveredModels?: readonly string[] | undefined;
  readonly aliasIssues: readonly AliasEditorIssue[];
  readonly transformsValid: boolean;
  readonly weightTie: boolean;
  readonly optionsValid?: boolean | undefined;
}

const SECTION_ORDER: readonly SectionId[] = ['identity', 'connection', 'models', 'routing', 'advanced'];

export function sectionStatuses(input: SectionStatusInput): Readonly<Record<SectionId, SectionStatus>> {
  // The id is server-assigned for oauth creation, so it can never be a todo there.
  const identity: SectionStatus =
    input.mode === 'create' && input.kind !== 'oauth' && input.id.trim() === '' ? 'todo' : 'ok';

  let connection: SectionStatus = 'ok';
  if (input.kind === 'api' && ((input.baseURL ?? '').trim() === '' || (input.protocol ?? '') === '')) {
    connection = 'todo';
  }
  if (input.kind === 'oauth' && (input.capabilityKey ?? '') === '') connection = 'todo';
  if (input.kind === 'ai-sdk' && input.optionsValid === false) connection = 'todo';

  let models: SectionStatus = 'ok';
  if (input.discoveredModels !== undefined && input.models.length > 0) {
    const discovered = new Set(input.discoveredModels);
    if (input.models.some((model) => !discovered.has(model))) models = 'attention';
  }

  // Alias issues block: validateAliasTargets turns them into a 400 on save.
  let routing: SectionStatus = input.aliasIssues.length > 0 ? 'todo' : 'ok';
  if (routing === 'ok' && input.weightTie) routing = 'attention';

  const advanced: SectionStatus = input.transformsValid ? 'ok' : 'todo';

  return { identity, connection, models, routing, advanced };
}

export function blockingSections(statuses: Readonly<Record<SectionId, SectionStatus>>): SectionId[] {
  return SECTION_ORDER.filter((section) => statuses[section] === 'todo');
}
