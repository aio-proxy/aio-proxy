import { m } from '@aio-proxy/i18n';
import type { AgentTarget } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Spinner } from '@aio-proxy/ui/components/spinner';

import { useAgentLogin } from '../../hooks/use-agent-login';
import { errorMessage } from '../../lib/agent-labels';
import { AGENT_DISPLAY_NAMES } from '../../lib/agent-state';

interface LoginPanelProps {
  readonly target: AgentTarget;
  readonly installationId: string;
  readonly loginCommand: string;
}

export const LoginPanel: React.FC<LoginPanelProps> = ({ target, installationId, loginCommand }) => {
  const name = AGENT_DISPLAY_NAMES[target];
  const login = useAgentLogin(installationId);
  const body = (() => {
    if (login.decision === 'approved')
      return <p className="text-sm">{m['dashboard.agents.login.approved']({ target: name })}</p>;
    if (login.decision === 'denied')
      return <p className="text-sm">{m['dashboard.agents.error.authorization_denied']()}</p>;
    if (login.pending === undefined)
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner />
          {m['dashboard.agents.login.waiting']({ target: name })}
        </p>
      );
    return (
      <div className="space-y-2" data-testid="login-request">
        <p className="text-sm">
          {m['dashboard.agents.login.pending']({
            target: name,
            installation: login.pending.installationId,
            version: login.pending.adapterVersion,
          })}
        </p>
        <div className="flex gap-2">
          <Button type="button" onClick={() => login.decide('approve')} disabled={login.isDeciding}>
            {m['dashboard.agents.action.approve']()}
          </Button>
          <Button type="button" variant="outline" onClick={() => login.decide('deny')} disabled={login.isDeciding}>
            {m['dashboard.agents.action.deny']()}
          </Button>
        </div>
      </div>
    );
  })();
  return (
    <div className="space-y-2" data-testid="login-panel">
      <p className="text-sm font-medium">{m['dashboard.agents.login.title']()}</p>
      <p className="text-sm">{m['dashboard.agents.login.instructions']({ target: name })}</p>
      <pre className="rounded-md bg-muted px-3 py-2 font-mono text-xs">{loginCommand}</pre>
      {body}
      {login.failed ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage('request_failed')}
        </p>
      ) : null}
    </div>
  );
};
