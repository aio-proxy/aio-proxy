import { m } from '@aio-proxy/i18n';
import type { TraceTerminationReason } from '@aio-proxy/types';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';
import { useEffect } from 'react';

import type { TraceFilterPatch, TraceSearch } from '../../lib/trace-search';

interface TracesResultFiltersProps {
  readonly search: TraceSearch;
  readonly onChange: (patch: TraceFilterPatch) => void;
}

export const TracesResultFilters: React.FC<TracesResultFiltersProps> = ({ search, onChange }) => {
  const form = useForm({
    defaultValues: {
      terminationReason: search.terminationReason ?? '',
      finalProviderId: search.finalProviderId ?? '',
      finalModelId: search.finalModelId ?? '',
      finalHttpStatus: search.finalHttpStatus?.toString() ?? '',
    },
  });

  useEffect(() => {
    form.setFieldValue('terminationReason', search.terminationReason ?? '');
    form.setFieldValue('finalProviderId', search.finalProviderId ?? '');
    form.setFieldValue('finalModelId', search.finalModelId ?? '');
    form.setFieldValue('finalHttpStatus', search.finalHttpStatus?.toString() ?? '');
  }, [form, search.finalHttpStatus, search.finalModelId, search.finalProviderId, search.terminationReason]);

  return (
    <>
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
      <form.Field name="finalProviderId">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="traces-final-provider-id">{m['dashboard.traces.final_provider']()}</FieldLabel>
            <Input
              id="traces-final-provider-id"
              value={field.state.value}
              onChange={(event) => {
                field.handleChange(event.target.value);
                onChange({ finalProviderId: event.target.value || undefined });
              }}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="finalModelId">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="traces-final-model-id">{m['dashboard.traces.final_model']()}</FieldLabel>
            <Input
              id="traces-final-model-id"
              value={field.state.value}
              onChange={(event) => {
                field.handleChange(event.target.value);
                onChange({ finalModelId: event.target.value || undefined });
              }}
            />
          </Field>
        )}
      </form.Field>
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
    </>
  );
};
