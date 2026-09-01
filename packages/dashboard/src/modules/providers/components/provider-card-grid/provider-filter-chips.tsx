import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import type React from 'react';

import type { ProviderListFilters } from '../../lib/provider-list-view';

interface ProviderFilterChipsProps {
  readonly filters: ProviderListFilters;
  readonly onChange: (filters: ProviderListFilters) => void;
}

/**
 * `value` is only the test id and React key. The literal that actually reaches `ProviderListFilters`
 * lives inside `select`, written at its declaration site, so each of the three filters keeps its own
 * union without a cast — a shared `value: string` would not be assignable to any of them.
 */
interface FilterOption {
  readonly value: string;
  readonly label: string;
  readonly select: () => void;
}

interface FilterGroup {
  readonly key: string;
  readonly label: string;
  readonly selected: string;
  readonly options: readonly FilterOption[];
}

export const ProviderFilterChips: React.FC<ProviderFilterChipsProps> = ({ filters, onChange }) => {
  const groups: readonly FilterGroup[] = [
    {
      key: 'availability',
      label: m['dashboard.providers.card.filter_availability'](),
      selected: filters.availability,
      options: [
        {
          value: 'all',
          label: m['dashboard.providers.card.filter_availability_all'](),
          select: () => onChange({ ...filters, availability: 'all' }),
        },
        {
          value: 'available',
          label: m['dashboard.providers.card.filter_availability_available'](),
          select: () => onChange({ ...filters, availability: 'available' }),
        },
        {
          value: 'unavailable',
          label: m['dashboard.providers.card.filter_availability_unavailable'](),
          select: () => onChange({ ...filters, availability: 'unavailable' }),
        },
      ],
    },
    {
      key: 'enablement',
      label: m['dashboard.providers.card.filter_enablement'](),
      selected: filters.enablement,
      options: [
        {
          value: 'all',
          label: m['dashboard.providers.card.filter_enablement_all'](),
          select: () => onChange({ ...filters, enablement: 'all' }),
        },
        {
          value: 'enabled',
          label: m['dashboard.providers.card.filter_enablement_enabled'](),
          select: () => onChange({ ...filters, enablement: 'enabled' }),
        },
        {
          value: 'disabled',
          label: m['dashboard.providers.card.filter_enablement_disabled'](),
          select: () => onChange({ ...filters, enablement: 'disabled' }),
        },
      ],
    },
    {
      key: 'kind',
      label: m['dashboard.providers.card.filter_kind'](),
      selected: filters.kind,
      // Kind values are protocol-level identifiers, not copy.
      options: [
        {
          value: 'all',
          label: m['dashboard.providers.card.filter_kind_all'](),
          select: () => onChange({ ...filters, kind: 'all' }),
        },
        { value: 'oauth', label: 'OAuth', select: () => onChange({ ...filters, kind: 'oauth' }) },
        { value: 'api', label: 'API', select: () => onChange({ ...filters, kind: 'api' }) },
        { value: 'ai-sdk', label: 'AI SDK', select: () => onChange({ ...filters, kind: 'ai-sdk' }) },
      ],
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {groups.map((group) => (
        // Toggle buttons, not radios: no arrow-key roving is implemented, so `aria-pressed` describes
        // what the control actually is. The group name is what makes three runs of "All" tellable apart.
        <div key={group.key} role="group" aria-label={group.label} className="flex flex-wrap items-center gap-1">
          <span aria-hidden="true" className="text-xs text-muted-foreground">
            {group.label}
          </span>
          {group.options.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="xs"
              variant={group.selected === option.value ? 'secondary' : 'ghost'}
              aria-pressed={group.selected === option.value}
              data-testid={`provider-filter-${group.key}-${option.value}`}
              onClick={option.select}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ))}
    </div>
  );
};
