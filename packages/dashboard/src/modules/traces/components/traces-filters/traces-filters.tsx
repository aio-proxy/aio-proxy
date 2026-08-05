import { m } from '@aio-proxy/i18n';
import { ProviderProtocol, type OtelSpanStatusCode } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Switch } from '@aio-proxy/ui/components/switch';
import { useForm } from '@tanstack/react-form';
import { endOfDay, startOfDay } from 'date-fns';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';
import { z } from 'zod';

import { DateTimeRangePicker } from '@/components/date-time-range-picker';
import { ProtocolLabel } from '@/components/protocol-label';

import {
  createDefaultTraceSearch,
  type TraceFilterPatch,
  type TraceSearch,
  withTraceFilters,
} from '../../lib/trace-search';
import { TracesAdvancedFilters } from '../traces-advanced-filters';
import { createTraceDateTimeRangePresets, toPickerRange, toQueryRange } from './date-range';

interface TracesFiltersProps {
  readonly search: TraceSearch;
  readonly autoRefresh: boolean;
  readonly refreshing: boolean;
  readonly onChange: (search: TraceSearch) => void;
  readonly onAutoRefresh: (value: boolean) => void;
  readonly onRefresh: () => void;
}

const schema = z.object({
  dateRange: z.object({ from: z.date(), to: z.date() }),
  requestedModelId: z.string(),
  otelStatusCode: z.string(),
  inboundProtocol: z.string(),
  autoRefresh: z.boolean(),
});

export const TracesFilters: React.FC<TracesFiltersProps> = ({
  search,
  autoRefresh,
  refreshing,
  onChange,
  onAutoRefresh,
  onRefresh,
}) => {
  const now = new Date();
  const retentionStart = startOfDay(new Date(now.getTime() - 45 * 86_400_000));
  const form = useForm({
    defaultValues: {
      dateRange: toPickerRange(search),
      requestedModelId: search.requestedModelId ?? '',
      otelStatusCode: search.otelStatusCode ?? '',
      inboundProtocol: search.inboundProtocol ?? '',
      autoRefresh,
    },
    validators: { onChange: schema },
  });
  const patch = (value: TraceFilterPatch) => onChange(withTraceFilters(search, value));
  const { startedAfter, startedBefore, requestedModelId, otelStatusCode, inboundProtocol } = search;

  useEffect(() => {
    form.setFieldValue('dateRange', toPickerRange({ startedAfter, startedBefore }));
    form.setFieldValue('requestedModelId', requestedModelId ?? '');
    form.setFieldValue('otelStatusCode', otelStatusCode ?? '');
    form.setFieldValue('inboundProtocol', inboundProtocol ?? '');
  }, [form, startedAfter, startedBefore, requestedModelId, otelStatusCode, inboundProtocol]);

  return (
    <div className="flex min-h-full flex-col gap-4">
      <form.Field name="dateRange">
        {(field) => (
          <Field className="w-full min-w-0">
            <FieldLabel>{m['dashboard.traces.range']()}</FieldLabel>
            <DateTimeRangePicker
              value={field.state.value}
              presets={createTraceDateTimeRangePresets()}
              min={retentionStart}
              max={endOfDay(now)}
              onChange={(value) => {
                field.handleChange(value);
                patch(toQueryRange(value));
              }}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="requestedModelId">
        {(field) => (
          <Field className="w-full">
            <FieldLabel htmlFor="traces-requested-model">{m['dashboard.traces.requested_model']()}</FieldLabel>
            <Input
              id="traces-requested-model"
              value={field.state.value}
              onChange={(event) => {
                field.handleChange(event.target.value);
                patch({ requestedModelId: event.target.value || undefined });
              }}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="otelStatusCode">
        {(field) => (
          <Field className="w-full">
            <FieldLabel>{m['dashboard.traces.otel_status']()}</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={(value) => {
                const next = value ?? '';
                field.handleChange(next);
                patch({ otelStatusCode: (next || undefined) as OtelSpanStatusCode | undefined });
              }}
            >
              <SelectTrigger className="w-full" aria-label={m['dashboard.traces.otel_status']()}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{m['dashboard.traces.all']()}</SelectItem>
                <SelectItem value="UNSET">UNSET</SelectItem>
                <SelectItem value="OK">OK</SelectItem>
                <SelectItem value="ERROR">ERROR</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <form.Field name="inboundProtocol">
        {(field) => (
          <Field className="w-full">
            <FieldLabel>{m['dashboard.traces.protocol']()}</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={(value) => {
                const next = value ?? '';
                field.handleChange(next);
                patch({ inboundProtocol: next || undefined });
              }}
            >
              <SelectTrigger className="w-full" aria-label={m['dashboard.traces.protocol']()}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{m['dashboard.traces.all']()}</SelectItem>
                {Object.values(ProviderProtocol).map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>
                    <ProtocolLabel protocol={protocol} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-3">
        <TracesAdvancedFilters search={search} onChange={patch} />
        {search.page === 1 && (
          <form.Field name="autoRefresh">
            {(field) => (
              <Field orientation="horizontal" className="h-9 w-auto px-1">
                <Switch
                  id="traces-auto-refresh"
                  checked={field.state.value}
                  onCheckedChange={(value) => {
                    field.handleChange(value);
                    onAutoRefresh(value);
                  }}
                />
                <FieldLabel htmlFor="traces-auto-refresh">{m['dashboard.traces.auto_refresh']()}</FieldLabel>
              </Field>
            )}
          </form.Field>
        )}
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={m['dashboard.traces.reset']()}
          onClick={() => onChange(createDefaultTraceSearch())}
        >
          <RotateCcw />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={m['dashboard.traces.refresh']()}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? 'animate-spin' : ''} />
        </Button>
      </div>
    </div>
  );
};
