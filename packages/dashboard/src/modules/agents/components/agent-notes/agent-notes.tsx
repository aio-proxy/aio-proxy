import { m } from '@aio-proxy/i18n';
import type { AgentDescriptor } from '@aio-proxy/types';

import { AGENT_DISPLAY_NAMES } from '../../lib/agent-state';

interface AgentNotesProps {
  readonly descriptor: AgentDescriptor;
  readonly localVisible: boolean;
}

export const AgentNotes: React.FC<AgentNotesProps> = ({ descriptor, localVisible }) => {
  const target = AGENT_DISPLAY_NAMES[descriptor.target];
  const notes = [
    ...(descriptor.catalog === 'synced' ? [m['dashboard.agents.note.catalog_synced']()] : []),
    ...(descriptor.catalog === 'host_managed' ? [m['dashboard.agents.note.catalog_host_managed']({ target })] : []),
    ...(descriptor.platformSupport === 'macos_only_verified' ? [m['dashboard.agents.note.platform_macos']()] : []),
    ...(descriptor.target === 'codex' ? [m['dashboard.agents.table.codex_keep']()] : []),
    ...(localVisible ? [] : [m['dashboard.agents.note.check_local']()]),
  ];
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" data-testid="agent-notes">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
};
