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

const INCOMPLETE = new Set<AgentOperationResult['status']>(['partial', 'blocked', 'cancelled']);

const migrationIncomplete = (result: AgentOperationResult): boolean =>
  result.migration?.status === 'partial' || result.migration?.status === 'blocked';

const headline = (result: AgentOperationResult): string => {
  if (result.status === 'removed') return m['dashboard.agents.result.removed']();
  if (result.status === 'partial')
    return m['dashboard.agents.result.partial']({ paths: (result.preservedPaths ?? []).join(', ') });
  if (result.status === 'blocked') return m['dashboard.agents.result.blocked']();
  if (result.status === 'cancelled') return m['dashboard.agents.result.cancelled']();
  return m['dashboard.agents.operation.succeeded']();
};

const revokeLabel = (status: NonNullable<AgentOperationResult['revokeStatus']>): string => {
  if (status === 'revoked') return m['dashboard.agents.authorization.revoked']();
  if (status === 'expired') return m['dashboard.agents.authorization.expired']();
  if (status === 'missing') return m['dashboard.agents.authorization.missing']();
  return m['dashboard.agents.authorization.pending']();
};

const detailLines = (result: AgentOperationResult): readonly string[] => {
  const target = AGENT_DISPLAY_NAMES[result.target];
  const removal = ['removed', 'partial', 'blocked'].includes(result.status);
  return [
    ...(result.configPath === undefined || removal
      ? []
      : [m['dashboard.agents.result.config_path']({ path: result.configPath })]),
    ...(result.revokeStatus === undefined
      ? []
      : [m['dashboard.agents.result.revoke']({ status: revokeLabel(result.revokeStatus) })]),
    ...(migrationIncomplete(result)
      ? [
          m['dashboard.agents.result.migration_incomplete']({
            migrated: String(result.migration?.migrated ?? 0),
            conflicts: String(result.migration?.conflicts ?? 0),
          }),
        ]
      : result.migration?.migrated === undefined || result.migration.migrated === 0
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
  const incomplete = INCOMPLETE.has(state.result.status) || migrationIncomplete(state.result);
  return (
    <div className="space-y-1 text-sm" role="status" data-testid="operation-result">
      <p role={incomplete ? 'alert' : undefined} className={incomplete ? 'text-destructive' : undefined}>
        {headline(state.result)}
      </p>
      {detailLines(state.result).map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
};
