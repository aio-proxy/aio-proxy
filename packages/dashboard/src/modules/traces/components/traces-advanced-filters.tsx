import { m } from '@aio-proxy/i18n';
import type { TraceTerminationReason } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldError, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@aio-proxy/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';
import { ListFilter } from 'lucide-react';
import { useEffect } from 'react';
import { z } from 'zod';

import type { TraceFilterPatch, TraceSearch } from '../trace-search';

interface TracesAdvancedFiltersProps {
  readonly search: TraceSearch;
  readonly onChange: (patch: TraceFilterPatch) => void;
}

const traceIdPattern = /^[0-9a-f]{32}$/u;
const traceIdSchema = z.string().refine((value) => value === '' || traceIdPattern.test(value));

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
    name: 'requestId' | 'sessionSource' | 'sessionId' | 'finalProviderId' | 'finalModelId',
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
          <form.Field
            name="traceId"
            validators={{
              onChange: ({ value }) => {
                const result = traceIdSchema.safeParse(value);
                return result.success ? undefined : m['dashboard.traces.trace_id_invalid']();
              },
            }}
          >
            {(field) => (
              <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
                <FieldLabel htmlFor="traces-traceId">{m['dashboard.traces.trace_id']()}</FieldLabel>
                <Input
                  id="traces-traceId"
                  aria-invalid={field.state.meta.errors.length > 0 || undefined}
                  value={field.state.value}
                  onChange={(event) => {
                    const value = event.target.value;
                    field.handleChange(value);
                    if (traceIdSchema.safeParse(value).success) onChange({ traceId: value || undefined });
                  }}
                />
                <FieldError errors={field.state.meta.errors.map((message) => ({ message: String(message) }))} />
              </Field>
            )}
          </form.Field>
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
