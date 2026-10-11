import { m } from '@aio-proxy/i18n';
import type { AgentDescriptor, AgentLocalSetup, AgentLocalState } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useState } from 'react';

import { useAgentOperation } from '../../hooks/use-agent-operation';
import { useClaudeCodePlan } from '../../hooks/use-claude-code-plan';
import { useCodexPlan } from '../../hooks/use-codex-plan';
import { actionLabel, errorMessage } from '../../lib/agent-labels';
import { primaryAgentAction } from '../../lib/agent-state';
import { AgentsRequestError } from '../../services/agents-service';
import { ClaudeCodeSetupForm } from '../claude-code-setup-form';
import { CodexSetupForm } from '../codex-setup-form';
import { LoginPanel } from '../login-panel';
import { OperationProgress } from '../operation-progress';

interface AgentSetupPanelProps {
  readonly descriptor: AgentDescriptor;
  readonly local: AgentLocalState | undefined;
  readonly localSetup: AgentLocalSetup;
  /** A configured installation that has not signed in yet, so a reloaded page can still offer the login. */
  readonly pendingLoginInstallationId?: string;
  /** Installations already signed in; reconfiguring one of them must not ask for another login. */
  readonly activeInstallationIds: ReadonlySet<string>;
}

const SETUP_KINDS = ['configure', 'restore_migration'] as const;

const requestError = (error: unknown): string =>
  errorMessage(error instanceof AgentsRequestError ? error.code : 'request_failed');

export const AgentSetupPanel: React.FC<AgentSetupPanelProps> = ({
  descriptor,
  local,
  localSetup,
  pendingLoginInstallationId,
  activeInstallationIds,
}) => {
  const operation = useAgentOperation(descriptor.target, SETUP_KINDS);
  const [codexOpen, setCodexOpen] = useState(false);
  const isCodex = descriptor.target === 'codex';
  const plan = useCodexPlan(isCodex && codexOpen && localSetup === 'available');
  const isClaudeCode = descriptor.target === 'claude-code';
  const claudeCodePlan = useClaudeCodePlan();
  const [claudeCodeOpen, setClaudeCodeOpen] = useState(false);
  const action = primaryAgentAction(local);
  const { state } = operation;
  const result = state?.status === 'succeeded' ? state.result : undefined;
  const candidate =
    result?.loginCommand === undefined
      ? state === undefined
        ? pendingLoginInstallationId
        : undefined
      : result.installationId;
  const loginInstallationId = candidate === undefined || activeInstallationIds.has(candidate) ? undefined : candidate;

  if (localSetup === 'unavailable') return null;
  return (
    <div className="space-y-4" data-testid="agent-setup-panel">
      {action === undefined ? null : (
        <Button
          type="button"
          disabled={localSetup !== 'available' || operation.busy || claudeCodePlan.isFetching}
          onClick={() => {
            if (isCodex) {
              setCodexOpen(true);
              return;
            }
            if (isClaudeCode) {
              // Without proxy keys there is nothing to choose, so the click configures right away.
              void claudeCodePlan.refetch().then(({ data, isError }) => {
                if (isError || data === undefined) return;
                if (data.keyChoices.length > 0) return setClaudeCodeOpen(true);
                operation.reset();
                operation.start({ kind: 'configure', target: 'claude-code', claudeCode: { key: { kind: 'none' } } });
              });
              return;
            }
            operation.reset();
            operation.start({ kind: 'configure', target: descriptor.target });
          }}
        >
          {actionLabel(action)}
        </Button>
      )}
      {isCodex && codexOpen ? (
        plan.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : plan.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {requestError(plan.error)}
          </p>
        ) : plan.data === undefined ? null : (
          <CodexSetupForm
            key={plan.data.planToken}
            plan={plan.data}
            busy={operation.busy}
            onSubmit={(codex) => {
              operation.reset();
              operation.start({ kind: 'configure', target: 'codex', codex });
            }}
            onRestoreMigration={(operationId) => {
              operation.reset();
              operation.start({ kind: 'restore_migration', target: 'codex', operationId });
            }}
          />
        )
      ) : null}
      {isClaudeCode && claudeCodePlan.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {requestError(claudeCodePlan.error)}
        </p>
      ) : null}
      {claudeCodeOpen && claudeCodePlan.data !== undefined && claudeCodePlan.data.keyChoices.length > 0 ? (
        <ClaudeCodeSetupForm
          key={claudeCodePlan.dataUpdatedAt}
          plan={claudeCodePlan.data}
          busy={operation.busy}
          onSubmit={(claudeCode) => {
            operation.reset();
            operation.start({ kind: 'configure', target: 'claude-code', claudeCode });
          }}
        />
      ) : null}
      {operation.startError === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {requestError(operation.startError)}
        </p>
      )}
      {state === undefined ? null : (
        <OperationProgress
          state={state}
          onDecide={operation.decide}
          deciding={operation.isDeciding}
          decideError={operation.decideError === undefined ? undefined : requestError(operation.decideError)}
        />
      )}
      {loginInstallationId === undefined || descriptor.loginCommand === undefined ? null : (
        <LoginPanel
          target={descriptor.target}
          installationId={loginInstallationId}
          loginCommand={descriptor.loginCommand}
        />
      )}
      {localSetup === 'remote_request' ? (
        <p className="text-sm text-muted-foreground">{m['dashboard.agents.banner.remote_request']()}</p>
      ) : null}
    </div>
  );
};
