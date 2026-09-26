import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';
import { useEffect } from 'react';
import type React from 'react';

import { UNKNOWN_LAB, labOptions } from '../lib/routing-rows';

interface RoutingLabFilterProps {
  readonly models: readonly DashboardRoutingModel[];
  readonly value: string | undefined;
  readonly onChange: (lab: string | undefined) => void;
}

export const RoutingLabFilter: React.FC<RoutingLabFilterProps> = ({ models, value, onChange }) => {
  const form = useForm({ defaultValues: { lab: value ?? '' } });

  useEffect(() => {
    form.setFieldValue('lab', value ?? '');
  }, [form, value]);

  return (
    <form.Field name="lab">
      {(field) => (
        <Field className="w-full sm:w-64">
          <FieldLabel>{m['dashboard.routing.lab.filter_label']()}</FieldLabel>
          <Select
            value={field.state.value}
            onValueChange={(next) => {
              const lab = next ?? '';
              field.handleChange(lab);
              onChange(lab || undefined);
            }}
          >
            <SelectTrigger className="w-full" aria-label={m['dashboard.routing.lab.filter_label']()}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{m['dashboard.routing.lab.filter_all']()}</SelectItem>
              {labOptions(models).map((lab) => (
                <SelectItem key={lab} value={lab}>
                  {lab === UNKNOWN_LAB ? m['dashboard.routing.lab.unknown']() : lab}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
    </form.Field>
  );
};
