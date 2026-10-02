import type { ClaudeCodeConfigureInput } from '@aio-proxy/types';
import { useForm } from '@tanstack/react-form';

export const useClaudeCodeSetupForm = (onSubmit: (input: ClaudeCodeConfigureInput) => void) =>
  useForm({
    // Empty on purpose: a proxy key is written only after the user picks it.
    defaultValues: { keyId: '' },
    onSubmit: ({ value }) => onSubmit({ key: { kind: 'existing', id: value.keyId } }),
  });
