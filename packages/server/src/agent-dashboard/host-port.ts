import type {
  AgentLocalState,
  AgentOperationErrorCode,
  AgentOperationResult,
  AgentTarget,
  CodexConfigureInput,
  CodexSetupPlan,
} from '@aio-proxy/types';

export type AgentOperationEvents = {
  readonly signal: AbortSignal;
  /** Called when a configure step starts a device authorization that the dashboard must approve. */
  readonly onDevice: (device: { readonly userCode: string }) => void;
};

/**
 * Writes Agent files on the machine running aio-proxy. The CLI injects it only when the server
 * shares a home directory with the user's Agents; the server itself never touches those files.
 */
export type AgentHostPort = {
  readonly inspect: () => Promise<readonly AgentLocalState[]>;
  readonly configure: (
    target: AgentTarget,
    codex: CodexConfigureInput | undefined,
    events: AgentOperationEvents,
  ) => Promise<AgentOperationResult>;
  readonly remove: (target: AgentTarget, events: AgentOperationEvents) => Promise<AgentOperationResult>;
  readonly codexPlan: () => Promise<CodexSetupPlan>;
  readonly restoreCodexMigration: (operationId: string, events: AgentOperationEvents) => Promise<AgentOperationResult>;
};

/** A failure the host port classified; anything else surfaces to the dashboard as `unknown`. */
export class AgentOperationError extends Error {
  constructor(readonly code: AgentOperationErrorCode) {
    super(code);
    this.name = 'AgentOperationError';
  }
}
