import type { AgentInstallationSummary, AgentLocalState, AgentTarget, AgentsSnapshot } from '@aio-proxy/types';

/** Product names are deliberately untranslated. */
export const AGENT_DISPLAY_NAMES: Readonly<Record<AgentTarget, string>> = {
  opencode: 'OpenCode',
  pi: 'Pi',
  omp: 'oh-my-pi',
  codex: 'Codex',
  grok: 'Grok Build',
};

export type PrimaryAgentAction = 'configure' | 'update' | 'repair' | 'reconfigure';

/** The one action the Agent card offers, or none when only the CLI can move it forward. */
export const primaryAgentAction = (local: AgentLocalState | undefined): PrimaryAgentAction | undefined => {
  switch (local?.status) {
    case 'not_configured':
      return 'configure';
    case 'outdated':
      return 'update';
    case 'modified':
    case 'missing':
      return 'repair';
    case 'configured':
      return local.endpointMatches === false ? 'repair' : 'reconfigure';
    default:
      return undefined;
  }
};

export type AgentInstallationRow = AgentInstallationSummary & {
  /** Undefined when local state is not visible to this browser. */
  readonly local?: 'configured' | 'orphaned';
};

export const agentInstallations = (snapshot: AgentsSnapshot, target: AgentTarget): readonly AgentInstallationRow[] => {
  const localId = snapshot.local?.find((row) => row.target === target)?.installationId;
  return snapshot.installations
    .filter((item) => item.target === target)
    .map((item) =>
      snapshot.local === undefined
        ? item
        : { ...item, local: item.installationId === localId ? 'configured' : 'orphaned' },
    );
};

export const authorizationCounts = (
  installations: readonly AgentInstallationSummary[],
): Readonly<Record<AgentInstallationSummary['authorization'], number>> => {
  const counts = { active: 0, expired: 0, revoked: 0 };
  for (const item of installations) counts[item.authorization] += 1;
  return counts;
};
