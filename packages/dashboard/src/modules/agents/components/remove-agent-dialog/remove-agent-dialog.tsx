import { m } from '@aio-proxy/i18n';
import type { AgentTarget } from '@aio-proxy/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@aio-proxy/ui/components/alert-dialog';
import { Button } from '@aio-proxy/ui/components/button';
import { useState } from 'react';

import { useAgentOperation } from '../../hooks/use-agent-operation';
import { errorMessage } from '../../lib/agent-labels';
import { AGENT_DISPLAY_NAMES } from '../../lib/agent-state';
import { AgentsRequestError } from '../../services/agents-service';
import { OperationProgress } from '../operation-progress';

interface RemoveAgentDialogProps {
  readonly target: AgentTarget;
  readonly disabled: boolean;
}

export const RemoveAgentDialog: React.FC<RemoveAgentDialogProps> = ({ target, disabled }) => {
  const [open, setOpen] = useState(false);
  const operation = useAgentOperation();
  const name = AGENT_DISPLAY_NAMES[target];
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) operation.reset();
        setOpen(next);
      }}
    >
      <AlertDialogTrigger render={<Button type="button" variant="destructive" disabled={disabled} />}>
        {m['dashboard.agents.action.remove']()}
      </AlertDialogTrigger>
      <AlertDialogContent data-testid="remove-agent-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{m['dashboard.agents.remove.title']({ target: name })}</AlertDialogTitle>
          <AlertDialogDescription>{m['dashboard.agents.remove.description']()}</AlertDialogDescription>
        </AlertDialogHeader>
        {operation.state === undefined ? null : (
          <OperationProgress state={operation.state} onDecide={operation.decide} deciding={operation.isDeciding} />
        )}
        {operation.startError === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(
              operation.startError instanceof AgentsRequestError ? operation.startError.code : 'request_failed',
            )}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{m['dashboard.agents.action.cancel']()}</AlertDialogCancel>
          {operation.state?.status === 'succeeded' ? null : (
            <AlertDialogAction
              variant="destructive"
              disabled={operation.busy}
              onClick={(event) => {
                event.preventDefault();
                operation.start({ kind: 'remove', target });
              }}
            >
              {m['dashboard.agents.action.remove']()}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
