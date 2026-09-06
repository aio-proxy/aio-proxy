import { m } from '@aio-proxy/i18n';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@aio-proxy/ui/components/item';
import { Switch } from '@aio-proxy/ui/components/switch';
import { useForm } from '@tanstack/react-form';
import { useEffect } from 'react';

import { useSettingsMutation } from '../../hooks/use-settings-mutation';

interface SettingsAutoUpdateRowProps {
  readonly autoUpdate: boolean;
  readonly managedService: boolean;
}

export const SettingsAutoUpdateRow: React.FC<SettingsAutoUpdateRowProps> = ({ autoUpdate, managedService }) => {
  const { isPending, mutate } = useSettingsMutation();
  const form = useForm({ defaultValues: { autoUpdate } });

  useEffect(() => {
    form.reset({ autoUpdate });
  }, [autoUpdate, form]);

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{m['dashboard.settings.auto_update']()}</ItemTitle>
        <ItemDescription>{m['dashboard.settings.auto_update_description']()}</ItemDescription>
        {managedService ? null : (
          <ItemDescription>{m['dashboard.settings.auto_update_unmanaged_hint']()}</ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        <form.Field name="autoUpdate">
          {(field) => (
            <Switch
              id={field.name}
              checked={field.state.value}
              disabled={isPending}
              aria-label={m['dashboard.settings.auto_update']()}
              onCheckedChange={(enabled) => {
                field.handleChange(enabled);
                mutate(
                  { autoUpdate: enabled },
                  {
                    onError: () => {
                      field.handleChange(autoUpdate);
                    },
                  },
                );
              }}
            />
          )}
        </form.Field>
      </ItemActions>
    </Item>
  );
};
