import { m } from '@aio-proxy/i18n';
import type { TraceTerminationReason } from '@aio-proxy/types';
import { useForm } from '@tanstack/react-form';
import { ListFilter } from 'lucide-react';
import { useEffect } from 'react';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import type { TraceFilterPatch, TraceSearch } from '../trace-search';

interface TracesAdvancedFiltersProps {
  readonly search: TraceSearch;
  readonly onChange: (patch: TraceFilterPatch) => void;
}

const schema = z.object({
  traceId: z.string(),
  requestId: z.string(),
  sessionSource: z.string(),
  sessionId: z.string(),
  terminationReason: z.string(),
  finalProviderId: z.string(),
  finalModelId: z.string(),
  finalHttpStatus: z.string(),
});

export const TracesAdvancedFilters: React.FC<TracesAdvancedFiltersProps> = ({ search, onChange }) => {
  const form = useForm({
    defaultValues: {
      traceId: search.traceId ?? '',
      requestId: search.requestId ?? '',
      sessionSource: search.sessionSource ?? '',
      sessionId: search.sessionId ?? '',
      terminationReason: search.terminationReason ?? '',
      finalProviderId: search.finalProviderId ?? '',
      finalModelId: search.finalModelId ?? '',
      finalHttpStatus: search.finalHttpStatus?.toString() ?? '',
    },
    validators: { onChange: schema },
  });
  useEffect(() => {
    form.setFieldValue('traceId', search.traceId ?? '');
    form.setFieldValue('requestId', search.requestId ?? '');
    form.setFieldValue('sessionSource', search.sessionSource ?? '');
    form.setFieldValue('sessionId', search.sessionId ?? '');
    form.setFieldValue('terminationReason', search.terminationReason ?? '');
    form.setFieldValue('finalProviderId', search.finalProviderId ?? '');
    form.setFieldValue('finalModelId', search.finalModelId ?? '');
    form.setFieldValue('finalHttpStatus', search.finalHttpStatus?.toString() ?? '');
  }, [form, search]);
  const activeCount = [
    search.traceId,
    search.requestId,
    search.sessionSource,
    search.sessionId,
    search.terminationReason,
    search.finalProviderId,
    search.finalModelId,
    search.finalHttpStatus,
  ].filter((value) => value !== undefined).length;
  const textField = (
    name: 'traceId' | 'requestId' | 'sessionSource' | 'sessionId' | 'finalProviderId' | 'finalModelId',
    label: string,
  ) => (
    <form.Field name={name}>
      {(field) => (
        <Field>
          <FieldLabel htmlFor={`traces-${name}`}>{label}</FieldLabel>
          <Input
            id={`traces-${name}`}
            value={field.state.value}
            onChange={(event) => {
              field.handleChange(event.target.value);
              onChange({ [name]: event.target.value || undefined });
            }}
          />
        </Field>
      )}
    </form.Field>
  );
  const clearFilters = () => {
    form.reset({
      traceId: '',
      requestId: '',
      sessionSource: '',
      sessionId: '',
      terminationReason: '',
      finalProviderId: '',
      finalModelId: '',
      finalHttpStatus: '',
    });
    onChange({
      traceId: undefined,
      requestId: undefined,
      sessionSource: undefined,
      sessionId: undefined,
      terminationReason: undefined,
      finalProviderId: undefined,
      finalModelId: undefined,
      finalHttpStatus: undefined,
    });
  };

  return (
    <Popover>
      <PopoverTrigger render={<Button type="button" variant="outline" />}>
        <ListFilter />
        {m['dashboard.traces.more_filters']()}
        {activeCount > 0 && <Badge variant="secondary">{activeCount}</Badge>}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
        <div className="grid gap-3">
          {textField('traceId', m['dashboard.traces.trace_id']())}
          {textField('requestId', m['dashboard.traces.request_id']())}
          {textField('sessionSource', m['dashboard.traces.session_source']())}
          {textField('sessionId', m['dashboard.traces.session_id']())}
          <form.Field name="terminationReason">
            {(field) => (
              <Field>
                <FieldLabel>{m['dashboard.traces.termination_reason']()}</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(value) => {
                    const next = value ?? '';
                    field.handleChange(next);
                    onChange({ terminationReason: (next || undefined) as TraceTerminationReason | undefined });
                  }}
                >
                  <SelectTrigger className="w-full" aria-label={m['dashboard.traces.termination_reason']()}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">{m['dashboard.traces.all']()}</SelectItem>
                    <SelectItem value="failure">{m['dashboard.traces.failure']()}</SelectItem>
                    <SelectItem value="cancelled">{m['dashboard.traces.cancelled']()}</SelectItem>
                    <SelectItem value="interrupted">{m['dashboard.traces.interrupted']()}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>
          {textField('finalProviderId', m['dashboard.traces.final_provider']())}
          {textField('finalModelId', m['dashboard.traces.final_model']())}
          <form.Field name="finalHttpStatus">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="traces-final-http-status">{m['dashboard.traces.final_http_status']()}</FieldLabel>
                <Input
                  id="traces-final-http-status"
                  type="number"
                  min={100}
                  max={599}
                  value={field.state.value}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    const status = Number(event.target.value);
                    onChange({
                      finalHttpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
                    });
                  }}
                />
              </Field>
            )}
          </form.Field>
          <Button type="button" variant="ghost" size="sm" disabled={activeCount === 0} onClick={clearFilters}>
            {m['dashboard.traces.clear_advanced_filters']()}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
