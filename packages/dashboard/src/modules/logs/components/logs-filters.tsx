import { m } from '@aio-proxy/i18n';
import { startOfDay } from 'date-fns';
import { RefreshCw, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';

import { createDefaultLogsSearch, type LogsFilterPatch, type LogsSearch, withLogsFilters } from '../logs-search';
import { LogsAdvancedFilters } from './logs-advanced-filters';
import { LogsFiltersFields } from './logs-filters-fields';
import { useLogsFiltersForm } from './use-logs-filters-form';

interface LogsFiltersProps {
  readonly search: LogsSearch;
  readonly autoRefresh: boolean;
  readonly refreshing: boolean;
  readonly onChange: (search: LogsSearch) => void;
  readonly onAutoRefresh: (value: boolean) => void;
  readonly onRefresh: () => void;
}

export const LogsFilters: React.FC<LogsFiltersProps> = ({
  search,
  autoRefresh,
  refreshing,
  onChange,
  onAutoRefresh,
  onRefresh,
}) => {
  const now = new Date();
  const retentionStart = startOfDay(new Date(now.getTime() - 45 * 86_400_000));
  const form = useLogsFiltersForm(search, autoRefresh);
  const patch = (value: LogsFilterPatch) => onChange(withLogsFilters(search, value));

  return (
    <div className="flex flex-wrap items-end gap-2">
      <LogsFiltersFields form={form} now={now} retentionStart={retentionStart} patch={patch} />
      <LogsAdvancedFilters search={search} onChange={patch} />
      {search.page === 1 && (
        <form.Field name="autoRefresh">
          {(field) => (
            <Field orientation="horizontal" className="h-9 w-auto px-1">
              <Switch
                id="logs-auto-refresh"
                checked={field.state.value}
                onCheckedChange={(value) => {
                  field.handleChange(value);
                  onAutoRefresh(value);
                }}
              />
              <FieldLabel htmlFor="logs-auto-refresh">{m['dashboard.logs.auto_refresh']()}</FieldLabel>
            </Field>
          )}
        </form.Field>
      )}
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={m['dashboard.logs.reset']()}
        onClick={() => onChange(createDefaultLogsSearch())}
      >
        <RotateCcw />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={m['dashboard.logs.refresh']()}
        onClick={onRefresh}
      >
        <RefreshCw className={refreshing ? 'animate-spin' : ''} />
      </Button>
    </div>
  );
};
