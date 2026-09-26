import { m } from '@aio-proxy/i18n';
import type { AgentOperationResult, AgentOperationState } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Spinner } from '@aio-proxy/ui/components/spinner';

import { errorMessage } from '../../lib/agent-labels';
import { AGENT_DISPLAY_NAMES } from '../../lib/agent-state';

interface OperationProgressProps {
  readonly state: AgentOperationState;
  readonly onDecide: (decision: 'approve' | 'deny' | 'cancel') => void;
  readonly deciding: boolean;
}

const resultLines = (result: AgentOperationResult): readonly string[] => {
  const target = AGENT_DISPLAY_NAMES[result.target];
  return [
    ...(result.status === 'removed'
      ? [m['dashboard.agents.result.removed']()]
      : [m['dashboard.agents.operation.succeeded']()]),
    ...(result.configPath === undefined || result.status === 'removed'
      ? []
      : [m['dashboard.agents.result.config_path']({ path: result.configPath })]),
    ...(result.migration?.migrated === undefined || result.migration.migrated === 0
      ? []
      : [m['dashboard.agents.result.migration']({ migrated: String(result.migration.migrated) })]),
    ...(result.skippedFields === undefined
      ? []
      : [m['dashboard.agents.remove.skipped']({ fields: result.skippedFields.join(', ') })]),
    ...(result.retainedFiles === undefined
      ? []
      : [m['dashboard.agents.remove.retained']({ files: result.retainedFiles.join(', ') })]),
    ...(result.loginCommand === undefined ? [] : [m['dashboard.agents.result.reload']({ target })]),
  ];
};

export const OperationProgress: React.FC<OperationProgressProps> = ({ state, onDecide, deciding }) => {
  if (state.status === 'running')
    return (
      <p className="flex items-center gap-2 text-sm" role="status">
        <Spinner />
        {m['dashboard.agents.operation.running']()}
      </p>
    );
  if (state.status === 'awaiting_approval')
    return (
      <div className="space-y-3" role="status" data-testid="operation-approval">
        <p className="text-sm">{m['dashboard.agents.operation.awaiting_approval']({ code: state.userCode })}</p>
        <p className="font-mono text-lg tracking-widest">{state.userCode}</p>
        <div className="flex gap-2">
          <Button type="button" onClick={() => onDecide('approve')} disabled={deciding}>
            {m['dashboard.agents.action.approve']()}
          </Button>
          <Button type="button" variant="outline" onClick={() => onDecide('deny')} disabled={deciding}>
            {m['dashboard.agents.action.deny']()}
          </Button>
          <Button type="button" variant="ghost" onClick={() => onDecide('cancel')} disabled={deciding}>
            {m['dashboard.agents.action.cancel']()}
          </Button>
        </div>
      </div>
    );
  if (state.status === 'failed')
    return (
      <p role="alert" className="text-sm text-destructive">
        {m['dashboard.agents.operation.failed']({ reason: errorMessage(state.error) })}
      </p>
    );
  return (
    <div className="space-y-1 text-sm" role="status" data-testid="operation-result">
      {resultLines(state.result).map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
};
