import { m } from '@aio-proxy/i18n';
import type { AgentDescriptor, AgentLocalSetup, AgentLocalState } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useState } from 'react';

import { useAgentOperation } from '../../hooks/use-agent-operation';
import { useCodexPlan } from '../../hooks/use-codex-plan';
import { actionLabel, errorMessage } from '../../lib/agent-labels';
import { primaryAgentAction } from '../../lib/agent-state';
import { AgentsRequestError } from '../../services/agents-service';
import { CodexSetupForm } from '../codex-setup-form';
import { LoginPanel } from '../login-panel';
import { OperationProgress } from '../operation-progress';

interface AgentSetupPanelProps {
  readonly descriptor: AgentDescriptor;
  readonly local: AgentLocalState | undefined;
  readonly localSetup: AgentLocalSetup;
}

const requestError = (error: unknown): string =>
  errorMessage(error instanceof AgentsRequestError ? error.code : 'request_failed');

export const AgentSetupPanel: React.FC<AgentSetupPanelProps> = ({ descriptor, local, localSetup }) => {
  const operation = useAgentOperation();
  const [codexOpen, setCodexOpen] = useState(false);
  const isCodex = descriptor.target === 'codex';
  const plan = useCodexPlan(isCodex && codexOpen && localSetup === 'available');
  const action = primaryAgentAction(local);
  const { state } = operation;
  const result = state?.status === 'succeeded' ? state.result : undefined;

  if (localSetup === 'unavailable') return null;
  return (
    <div className="space-y-4" data-testid="agent-setup-panel">
      {action === undefined ? null : (
        <Button
          type="button"
          disabled={localSetup !== 'available' || operation.busy}
          onClick={() => {
            if (isCodex) {
              setCodexOpen(true);
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
      {operation.startError === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {requestError(operation.startError)}
        </p>
      )}
      {state === undefined ? null : (
        <OperationProgress state={state} onDecide={operation.decide} deciding={operation.isDeciding} />
      )}
      {result?.installationId === undefined || result.loginCommand === undefined ? null : (
        <LoginPanel
          target={descriptor.target}
          installationId={result.installationId}
          loginCommand={result.loginCommand}
        />
      )}
      {localSetup === 'remote_request' ? (
        <p className="text-sm text-muted-foreground">{m['dashboard.agents.banner.remote_request']()}</p>
      ) : null}
    </div>
  );
};
