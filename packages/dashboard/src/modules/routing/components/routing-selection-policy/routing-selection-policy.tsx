import { m } from '@aio-proxy/i18n';
import type { RouterSelection } from '@aio-proxy/types';
import { Field, FieldContent, FieldDescription } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import { Switch } from '@aio-proxy/ui/components/switch';
import { useForm } from '@tanstack/react-form';

import { useRoutingSelectionMutation } from '../../hooks/use-routing-selection-mutation';

interface RoutingSelectionPolicyProps {
  readonly selection: RouterSelection;
  readonly writable: boolean;
}

/** The global `router.selection` switch. Saves on toggle; a failed save puts the switch back. */
export const RoutingSelectionPolicy: React.FC<RoutingSelectionPolicyProps> = ({ selection, writable }) => {
  const mutation = useRoutingSelectionMutation();
  const form = useForm({ defaultValues: { quotaReset: selection === 'quota-reset' } });

  return (
    <form.Field name="quotaReset">
      {(field) => (
        <Field orientation="horizontal">
          <FieldContent>
            <Label htmlFor={field.name}>{m['dashboard.routing.selection_quota_reset']()}</Label>
            <FieldDescription>{m['dashboard.routing.selection_quota_reset_description']()}</FieldDescription>
          </FieldContent>
          <Switch
            id={field.name}
            checked={field.state.value}
            disabled={!writable || mutation.isPending}
            onCheckedChange={(checked) => {
              field.handleChange(checked);
              mutation.mutate(
                { selection: checked ? 'quota-reset' : 'weighted' },
                { onError: () => field.handleChange(!checked) },
              );
            }}
          />
        </Field>
      )}
    </form.Field>
  );
};
