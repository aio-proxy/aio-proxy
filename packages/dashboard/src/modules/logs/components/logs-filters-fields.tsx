import { m } from '@aio-proxy/i18n';
import { ProviderProtocol, type RequestOutcome } from '@aio-proxy/types';
import { endOfDay } from 'date-fns';

import { DateTimeRangePicker } from '@/components/date-time-range-picker';
import { ProtocolLabel } from '@/components/protocol-label';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { createLogsDateTimeRangePresets, toQueryRange } from '../log-date-range';
import type { LogsFilterPatch } from '../logs-search';
import type { useLogsFiltersForm } from './use-logs-filters-form';

interface LogsFiltersFieldsProps {
  readonly form: ReturnType<typeof useLogsFiltersForm>;
  readonly now: Date;
  readonly retentionStart: Date;
  readonly patch: (value: LogsFilterPatch) => void;
}

export const LogsFiltersFields: React.FC<LogsFiltersFieldsProps> = ({ form, now, retentionStart, patch }) => (
  <>
    <form.Field name="dateRange">
      {(field) => (
        <Field className="w-auto min-w-60 flex-1">
          <FieldLabel>{m['dashboard.logs.range']()}</FieldLabel>
          <DateTimeRangePicker
            value={field.state.value}
            presets={createLogsDateTimeRangePresets()}
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
        <Field className="w-auto min-w-52 flex-1">
          <FieldLabel htmlFor="logs-requestedModelId">{m['dashboard.logs.requested_model']()}</FieldLabel>
          <Input
            id="logs-requestedModelId"
            value={field.state.value}
            onChange={(event) => {
              field.handleChange(event.target.value);
              patch({ requestedModelId: event.target.value || undefined });
            }}
          />
        </Field>
      )}
    </form.Field>
    <form.Field name="outcome">
      {(field) => (
        <Field className="w-36">
          <FieldLabel>{m['dashboard.logs.outcome']()}</FieldLabel>
          <Select
            value={field.state.value}
            onValueChange={(value) => {
              const next = value ?? '';
              field.handleChange(next);
              patch({ outcome: (next || undefined) as RequestOutcome | undefined });
            }}
          >
            <SelectTrigger className="w-full" aria-label={m['dashboard.logs.outcome']()}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{m['dashboard.logs.all']()}</SelectItem>
              <SelectItem value="success">{m['dashboard.logs.success']()}</SelectItem>
              <SelectItem value="failure">{m['dashboard.logs.failure']()}</SelectItem>
              <SelectItem value="cancelled">{m['dashboard.logs.cancelled']()}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}
    </form.Field>
    <form.Field name="inboundProtocol">
      {(field) => (
        <Field className="w-44">
          <FieldLabel>{m['dashboard.logs.protocol']()}</FieldLabel>
          <Select
            value={field.state.value}
            onValueChange={(value) => {
              const next = value ?? '';
              field.handleChange(next);
              patch({ inboundProtocol: next || undefined });
            }}
          >
            <SelectTrigger className="w-full" aria-label={m['dashboard.logs.protocol']()}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{m['dashboard.logs.all']()}</SelectItem>
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
  </>
);
