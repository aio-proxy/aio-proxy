import { m } from '@aio-proxy/i18n';
import { Field, FieldError, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { useForm } from '@tanstack/react-form';
import { useEffect } from 'react';
import { z } from 'zod';

import type { TraceFilterPatch, TraceSearch } from '../../lib/trace-search';

interface TracesRequestFiltersProps {
  readonly search: TraceSearch;
  readonly onChange: (patch: TraceFilterPatch) => void;
}

const traceIdPattern = /^[0-9a-f]{32}$/u;
const traceIdSchema = z.string().refine((value) => value === '' || traceIdPattern.test(value));

export const TracesRequestFilters: React.FC<TracesRequestFiltersProps> = ({ search, onChange }) => {
  const form = useForm({
    defaultValues: {
      traceId: search.traceId ?? '',
      requestId: search.requestId ?? '',
      sessionSource: search.sessionSource ?? '',
      sessionId: search.sessionId ?? '',
    },
  });

  useEffect(() => {
    form.setFieldValue('traceId', search.traceId ?? '');
    form.setFieldValue('requestId', search.requestId ?? '');
    form.setFieldValue('sessionSource', search.sessionSource ?? '');
    form.setFieldValue('sessionId', search.sessionId ?? '');
  }, [form, search.requestId, search.sessionId, search.sessionSource, search.traceId]);

  return (
    <>
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
            <FieldLabel htmlFor="traces-trace-id">{m['dashboard.traces.trace_id']()}</FieldLabel>
            <Input
              id="traces-trace-id"
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
      <form.Field name="requestId">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="traces-request-id">{m['dashboard.traces.request_id']()}</FieldLabel>
            <Input
              id="traces-request-id"
              value={field.state.value}
              onChange={(event) => {
                field.handleChange(event.target.value);
                onChange({ requestId: event.target.value || undefined });
              }}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="sessionSource">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="traces-session-source">{m['dashboard.traces.session_source']()}</FieldLabel>
            <Input
              id="traces-session-source"
              value={field.state.value}
              onChange={(event) => {
                field.handleChange(event.target.value);
                onChange({ sessionSource: event.target.value || undefined });
              }}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="sessionId">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="traces-session-id">{m['dashboard.traces.session_id']()}</FieldLabel>
            <Input
              id="traces-session-id"
              value={field.state.value}
              onChange={(event) => {
                field.handleChange(event.target.value);
                onChange({ sessionId: event.target.value || undefined });
              }}
            />
          </Field>
        )}
      </form.Field>
    </>
  );
};
