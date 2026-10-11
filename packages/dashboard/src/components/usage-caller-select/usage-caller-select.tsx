import { m } from '@aio-proxy/i18n';
import { Field } from '@aio-proxy/ui/components/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';

import { usageCallerLabel } from '@/lib/usage-caller-label';
import { callersQueryOptions } from '@/modules/callers/services/callers-service';

interface UsageCallerSelectProps {
  readonly value?: string;
  readonly onChange: (value: string | undefined) => void;
}

export const UsageCallerSelect: React.FC<UsageCallerSelectProps> = ({ value, onChange }) => {
  const query = useQuery(callersQueryOptions());
  const form = useForm({
    defaultValues: { callerId: value ?? 'all' },
    validators: { onChange: z.object({ callerId: z.string().min(1) }) },
  });
  useEffect(() => {
    form.setFieldValue('callerId', value ?? 'all');
  }, [form, value]);
  const callers = query.data ?? [];
  const choices = [
    { value: 'all', label: m['dashboard.callers.all']() },
    ...callers
      .filter((caller) => caller.kind !== 'legacy' && caller.kind !== 'anonymous')
      .map((caller) => ({ value: caller.id, label: usageCallerLabel(caller) })),
    { value: 'anonymous', label: m['dashboard.callers.anonymous']() },
    { value: 'legacy', label: m['dashboard.callers.legacy']() },
  ];
  if (value !== undefined && !choices.some((choice) => choice.value === value)) choices.push({ value, label: value });
  return (
    <div className="max-w-64 min-w-40">
      <form.Field name="callerId">
        {(field) => (
          <Field>
            <Select
              items={choices}
              value={field.state.value}
              onValueChange={(id) => {
                if (id === null) return;
                field.handleChange(id);
                onChange(id === 'all' ? undefined : id);
              }}
            >
              <SelectTrigger aria-label={m['dashboard.callers.label']()}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      {query.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {m['dashboard.callers.load_error']()}
        </p>
      ) : null}
    </div>
  );
};
