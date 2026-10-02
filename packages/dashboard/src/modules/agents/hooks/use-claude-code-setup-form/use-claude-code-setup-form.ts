import type { ClaudeCodeConfigureInput, ClaudeCodeSetupPlan } from '@aio-proxy/types';
import { useForm } from '@tanstack/react-form';

export const useClaudeCodeSetupForm = (
  plan: ClaudeCodeSetupPlan,
  onSubmit: (input: ClaudeCodeConfigureInput) => void,
) =>
  useForm({
    defaultValues: { keyId: plan.keyChoices[0]?.id ?? '' },
    onSubmit: ({ value }) => onSubmit({ key: { kind: 'existing', id: value.keyId } }),
  });
