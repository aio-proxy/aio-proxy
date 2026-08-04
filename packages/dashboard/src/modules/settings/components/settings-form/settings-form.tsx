import { type DashboardSettingsMutationInput, DashboardSettingsMutationSchema } from '@aio-proxy/types';
import { useState } from 'react';

import { useSettingsMutation } from '../../hooks/use-settings-mutation';
import { SettingsAccessConfirmationDialog } from './settings-access-confirmation-dialog';
import type { PendingAccessChange, SettingsFormProps } from './settings-form-contract';
import { SettingsLogsGroup } from './settings-logs-group';
import { SettingsMutationStatus } from './settings-mutation-status';
import { SettingsServiceGroup } from './settings-service-group';
import { useSettingsForm } from './use-settings-form';

export const SettingsForm: React.FC<SettingsFormProps> = ({ settings }) => {
  const mutation = useSettingsMutation();
  const [pendingAccess, setPendingAccess] = useState<PendingAccessChange>();
  const form = useSettingsForm(settings);

  const save = (input: DashboardSettingsMutationInput) => {
    const parsed = DashboardSettingsMutationSchema.safeParse(input);
    if (parsed.success) mutation.mutate(parsed.data);
  };
  const closeConfirmation = () => {
    if (pendingAccess?.field === 'host') form.setFieldValue('host', settings.host);
    if (pendingAccess?.field === 'port') form.setFieldValue('port', settings.port);
    setPendingAccess(undefined);
  };
  const confirmAccessChange = () => {
    if (pendingAccess === undefined) return;
    mutation.mutate(pendingAccess.input);
    setPendingAccess(undefined);
  };

  return (
    <form className="space-y-6" noValidate onSubmit={(event) => event.preventDefault()} aria-busy={mutation.isPending}>
      <SettingsServiceGroup
        disabled={mutation.isPending}
        form={form}
        settings={settings}
        onAccessChange={(field, input) => setPendingAccess({ field, input })}
        onSave={save}
      />
      <SettingsLogsGroup disabled={mutation.isPending} form={form} settings={settings} onSave={save} />
      <SettingsMutationStatus data={mutation.data} isError={mutation.isError} />
      <SettingsAccessConfirmationDialog
        open={pendingAccess !== undefined}
        onCancel={closeConfirmation}
        onConfirm={confirmAccessChange}
      />
    </form>
  );
};
