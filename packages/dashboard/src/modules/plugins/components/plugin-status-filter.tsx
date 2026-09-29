import { m } from '@aio-proxy/i18n';
import { ToggleGroup, ToggleGroupItem } from '@aio-proxy/ui/components/toggle-group';
import type React from 'react';

export type PluginStatusFilterValue = 'all' | 'enabled' | 'failed' | 'builtin';

interface PluginStatusFilterProps {
  readonly value: PluginStatusFilterValue;
  readonly failedCount: number;
  readonly onChange: (value: PluginStatusFilterValue) => void;
}

export const PluginStatusFilter: React.FC<PluginStatusFilterProps> = ({ value, failedCount, onChange }) => {
  const items: readonly [PluginStatusFilterValue, string][] = [
    ['all', m['dashboard.plugins.filter_all']()],
    ['enabled', m['dashboard.plugins.filter_enabled']()],
    ['failed', `${m['dashboard.plugins.filter_failed']()}${failedCount > 0 ? ` ${failedCount}` : ''}`],
    ['builtin', m['dashboard.plugins.filter_builtin']()],
  ];

  return (
    <ToggleGroup
      variant="outline"
      aria-label={m['dashboard.plugins.filter_label']()}
      value={[value]}
      onValueChange={(next) => {
        // Base UI lets the active item be toggled off; a filter always keeps one selected.
        const picked = next[0] as PluginStatusFilterValue | undefined;
        if (picked !== undefined) onChange(picked);
      }}
    >
      {items.map(([key, text]) => (
        <ToggleGroupItem key={key} value={key}>
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
};
