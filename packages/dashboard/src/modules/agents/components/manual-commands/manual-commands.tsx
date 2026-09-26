import { m } from '@aio-proxy/i18n';
import type { AgentDescriptor } from '@aio-proxy/types';

interface ManualCommandsProps {
  readonly descriptor: AgentDescriptor;
}

export const ManualCommands: React.FC<ManualCommandsProps> = ({ descriptor }) => {
  const commands: ReadonlyArray<readonly [string, string]> = [
    [m['dashboard.agents.manual.configure'](), descriptor.configureCommand],
    ...(descriptor.loginCommand === undefined
      ? []
      : ([[m['dashboard.agents.manual.login'](), descriptor.loginCommand]] as const)),
    [m['dashboard.agents.manual.check'](), 'aio-proxy agent list --check'],
    [m['dashboard.agents.manual.remove'](), descriptor.removeCommand],
  ];
  return (
    <dl className="space-y-3" data-testid="manual-commands">
      {commands.map(([label, command]) => (
        <div key={command} className="space-y-1">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd>
            <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">{command}</pre>
          </dd>
        </div>
      ))}
    </dl>
  );
};
