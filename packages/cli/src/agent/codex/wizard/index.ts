import { CodexConfigWriteError } from '@aio-proxy/i18n';

import { validateCodexProviderId } from '../config-document';
import type {
  ConfigCommit,
  ConfigInspection,
  CodexLocation,
  KeyChoice,
  KeySelection,
  KeySnapshot,
  MigrationPreview,
  MigrationResult,
  MigrationTarget,
  SessionGroup,
} from '../contracts';

export type CodexConfigureResult = {
  readonly target: 'codex';
  readonly integration: 'static-config';
  readonly status: 'configured' | 'unchanged' | 'cancelled';
  readonly providerId?: string;
  readonly configPath: string;
  readonly connection: 'ok' | 'offline' | 'not_checked';
  readonly credential: 'none' | 'placeholder' | 'existing' | 'created';
  readonly migration: MigrationResult | { readonly status: 'declined' | 'empty' | 'not_requested' };
  readonly reason?: 'non_interactive';
  readonly version?: string;
  readonly versionCompatibility?: 'unverified';
  readonly migrationAction?: 'restore';
};

export type CodexPrompts = {
  readonly providerId: (defaultId: string, occupied: readonly string[]) => Promise<string>;
  readonly key: (choices: readonly KeyChoice[]) => Promise<KeySelection>;
  readonly sources: (groups: readonly SessionGroup[], previous: string) => Promise<readonly string[]>;
  readonly migrate: (input: {
    readonly sources: readonly string[];
    readonly target: string;
    readonly active: number;
    readonly archived: number;
  }) => Promise<boolean>;
};

export type WizardDeps = {
  readonly location: CodexLocation;
  readonly endpoint: string;
  readonly isTTY: boolean;
  readonly prompts: CodexPrompts;
  readonly inspectConfig: () => Promise<ConfigInspection>;
  readonly occupiedIds: () => Promise<readonly string[]>;
  readonly inspectKeys: () => Promise<KeySnapshot>;
  readonly inspectSessions: (providerId?: string) => Promise<MigrationPreview>;
  readonly saveConfig: (providerId: string, token: string) => Promise<ConfigCommit>;
  readonly migrateSessions: (targets: readonly MigrationTarget[], providerId: string) => Promise<MigrationResult>;
};

const cancelledError = (error: unknown): boolean => {
  if (error instanceof Error && /(?:abort|cancel|exit)prompt/i.test(error.name)) return true;
  return error instanceof Error && /(?:cancelled|canceled)/i.test(error.message);
};

const cancelledResult = (location: CodexLocation, reason?: 'non_interactive'): CodexConfigureResult => ({
  target: 'codex',
  integration: 'static-config',
  status: 'cancelled',
  configPath: location.configPath,
  connection: 'not_checked',
  credential: 'none',
  migration: { status: 'not_requested' },
  ...(reason === undefined ? {} : { reason }),
});

const validateProvider = (providerId: string, occupied: ReadonlySet<string>): string => {
  const normalized = validateCodexProviderId(providerId);
  if (occupied.has(normalized)) throw new Error(`Codex provider ${normalized} is occupied`);
  return normalized;
};

const migrationSelection = async (
  preview: MigrationPreview,
  providerId: string,
  previousProviderId: string,
  prompts: CodexPrompts,
): Promise<
  | {
      readonly accepted: false;
      readonly result: { readonly status: 'declined' | 'empty' | 'not_requested' } | MigrationResult;
    }
  | { readonly accepted: true; readonly targets: readonly MigrationTarget[] }
> => {
  if (preview.blocked.length > 0)
    return {
      accepted: false,
      result: { status: 'blocked', migrated: 0, skipped: 0, conflicts: preview.blocked.length },
    };
  if (preview.targets.length === 0) return { accepted: false, result: { status: 'empty' } };
  const groups = preview.groups.filter((group) => group.providerId !== providerId);
  if (groups.length === 0) return { accepted: false, result: { status: 'empty' } };
  const selected =
    groups.length === 1
      ? [groups[0]!.providerId]
      : await prompts.sources(groups, previousProviderId || groups[0]!.providerId);
  const sourceSet = new Set(selected);
  const targets = preview.targets.filter((target) => sourceSet.has(target.sourceProviderId));
  if (targets.length === 0) return { accepted: false, result: { status: 'empty' } };
  const counts = targets.reduce(
    (result, target) => ({
      active: result.active + (target.archived ? 0 : 1),
      archived: result.archived + (target.archived ? 1 : 0),
    }),
    { active: 0, archived: 0 },
  );
  const accepted = await prompts.migrate({
    sources: selected,
    target: providerId,
    active: counts.active,
    archived: counts.archived,
  });
  return accepted ? { accepted: true, targets } : { accepted: false, result: { status: 'declined' } };
};

export async function runCodexWizard(deps: WizardDeps): Promise<CodexConfigureResult> {
  if (!deps.isTTY) return cancelledResult(deps.location, 'non_interactive');
  try {
    const inspection = await deps.inspectConfig();
    const occupied = new Set(await deps.occupiedIds());
    const defaultId = inspection.providerId ?? 'aio-proxy';
    const providerId = validateProvider(await deps.prompts.providerId(defaultId, [...occupied]), occupied);
    const keys = await deps.inspectKeys();
    const selection = keys.choices.length === 0 ? ({ kind: 'none' } as const) : await deps.prompts.key(keys.choices);
    const preview = await deps.inspectSessions(providerId);
    const previousProviderId = (inspection.providerId ?? inspection.activeProviderId) || 'openai';
    const migration = await migrationSelection(preview, providerId, previousProviderId, deps.prompts);
    const credential = await keys.resolve(selection, providerId);
    let commit: ConfigCommit;
    try {
      commit = await deps.saveConfig(providerId, credential.token);
    } catch (error) {
      if (credential.kind === 'created') throw new CodexConfigWriteError(providerId);
      throw error;
    }
    let migrationResult: MigrationResult | { readonly status: 'declined' | 'empty' | 'not_requested' } =
      migration.accepted ? { status: 'not_requested' } : migration.result;
    if (migration.accepted) {
      try {
        migrationResult = await deps.migrateSessions(migration.targets, providerId);
      } catch {
        migrationResult = { status: 'blocked', migrated: 0, skipped: 0, conflicts: 1 };
      }
    }
    return {
      target: 'codex',
      integration: 'static-config',
      status: commit.status,
      providerId,
      configPath: deps.location.configPath,
      connection: credential.kind === 'placeholder' ? 'not_checked' : credential.verified ? 'ok' : 'offline',
      credential: credential.kind,
      migration: migrationResult,
    };
  } catch (error) {
    if (cancelledError(error)) return cancelledResult(deps.location);
    throw error;
  }
}
