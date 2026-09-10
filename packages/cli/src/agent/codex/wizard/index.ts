import { validateCodexProviderId } from '../config-document';
import type {
  ConfigInspection,
  CodexAuthMode,
  CodexLocation,
  CodexSetupCommit,
  CodexSetupSelection,
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
  readonly credential: 'none' | 'placeholder' | 'existing' | 'agent';
  readonly authMode?: CodexAuthMode;
  readonly installationId?: string;
  readonly migration: MigrationResult | { readonly status: 'declined' | 'empty' | 'not_requested' };
  readonly reason?: 'non_interactive' | 'authorization_incomplete';
  readonly version?: string;
  readonly versionCompatibility?: 'unverified';
  readonly migrationAction?: 'restore';
};

export type CodexPrompts = {
  readonly providerId: (defaultId: string, occupied: readonly string[]) => Promise<string>;
  readonly authMode: (defaultMode: CodexAuthMode) => Promise<CodexAuthMode>;
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
  readonly resolveCommand: () => Promise<string>;
  readonly commitSetup: (selection: CodexSetupSelection) => Promise<CodexSetupCommit>;
  readonly migrateSessions: (targets: readonly MigrationTarget[], providerId: string) => Promise<MigrationResult>;
};

const cancelledError = (error: unknown): boolean => {
  if (error === null || typeof error !== 'object') return false;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return /abort|(?:cancel|exit)prompt|(?:cancelled|canceled)/i.test(`${name} ${message}`);
};

export const cancelledResult = (
  location: CodexLocation,
  reason?: 'non_interactive' | 'authorization_incomplete',
  details?: { readonly providerId?: string; readonly authMode?: CodexAuthMode },
): CodexConfigureResult => ({
  target: 'codex',
  integration: 'static-config',
  status: 'cancelled',
  configPath: location.configPath,
  connection: 'not_checked',
  credential: 'none',
  migration: { status: 'not_requested' },
  ...(details?.providerId === undefined ? {} : { providerId: details.providerId }),
  ...(details?.authMode === undefined ? {} : { authMode: details.authMode }),
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
  let commitStarted = false;
  let selectedProviderId: string | undefined;
  let selectedAuthMode: CodexAuthMode | undefined;
  try {
    const inspection = await deps.inspectConfig();
    const occupied = new Set(await deps.occupiedIds());
    const defaultId = inspection.providerId ?? 'aio-proxy';
    const providerId = validateProvider(await deps.prompts.providerId(defaultId, [...occupied]), occupied);
    selectedProviderId = providerId;
    const mode = await deps.prompts.authMode(inspection.authMode ?? 'keep-chatgpt');
    selectedAuthMode = mode;
    const auth: CodexSetupSelection['auth'] =
      mode === 'command'
        ? { mode, command: await deps.resolveCommand() }
        : await (async () => {
            const keys = await deps.inspectKeys();
            const selection =
              keys.choices.length === 0 ? ({ kind: 'none' } as const) : await deps.prompts.key(keys.choices);
            return { mode, keys, selection };
          })();
    const preview = await deps.inspectSessions(providerId);
    const previousProviderId = (inspection.providerId ?? inspection.activeProviderId) || 'openai';
    const migration = await migrationSelection(preview, providerId, previousProviderId, deps.prompts);
    commitStarted = true;
    const commit = await deps.commitSetup({ providerId, auth });
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
      connection: commit.connection,
      credential: commit.credential,
      authMode: commit.authMode,
      ...(commit.installationId === undefined ? {} : { installationId: commit.installationId }),
      migration: migrationResult,
    };
  } catch (error) {
    if (cancelledError(error))
      return cancelledResult(
        deps.location,
        commitStarted && selectedAuthMode === 'command' ? 'authorization_incomplete' : undefined,
        commitStarted && selectedAuthMode === 'command'
          ? { providerId: selectedProviderId, authMode: selectedAuthMode }
          : undefined,
      );
    throw error;
  }
}
