import type { CodexConfigureInput, CodexSetupPlan } from '@aio-proxy/types';
import { useForm } from '@tanstack/react-form';

export type CodexSetupFormValues = {
  providerId: string;
  authMode: CodexConfigureInput['auth']['mode'];
  keyId: string;
  migrateFrom: string[];
  confirmMigration: boolean;
};

/** Empty when no key is selected; the wizard then writes a placeholder key. */
const NO_KEY = '';

export const useCodexSetupForm = (plan: CodexSetupPlan, onSubmit: (input: CodexConfigureInput) => void) =>
  useForm({
    defaultValues: {
      providerId: plan.defaultProviderId,
      authMode: plan.defaultAuthMode,
      keyId: plan.keyChoices[0]?.id ?? NO_KEY,
      migrateFrom: [],
      confirmMigration: false,
    } as CodexSetupFormValues,
    onSubmit: ({ value }) =>
      onSubmit({
        providerId: value.providerId.trim(),
        auth:
          value.authMode === 'command'
            ? { mode: 'command' }
            : {
                mode: 'keep-chatgpt',
                key: value.keyId === NO_KEY ? { kind: 'none' } : { kind: 'existing', id: value.keyId },
              },
        migrateFrom: value.migrateFrom.filter((providerId) => providerId !== value.providerId.trim()),
        planToken: plan.planToken,
      }),
  });
