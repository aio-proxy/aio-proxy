import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldDescription } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useSelector } from '@tanstack/react-store';

import type { ProviderForm } from '../../hooks/use-provider-form';
import { useProviderTestMutation } from '../../hooks/use-provider-test-mutation';

interface ProviderValidateStepProps {
  readonly form: ProviderForm;
  readonly persistedProviderId?: string;
}

export const ProviderValidateStep: React.FC<ProviderValidateStepProps> = ({ form, persistedProviderId }) => {
  const values = useSelector(form.store, (state) => state.values);
  const models = values.models ?? [];
  const configuredModel = values.validationModel;
  const selectedModel = configuredModel !== undefined && models.includes(configuredModel) ? configuredModel : models[0];
  const testMutation = useProviderTestMutation(form, persistedProviderId);
  const tested = testMutation.data;
  let result: typeof tested.result | null = null;
  if (tested !== undefined && tested.model === selectedModel) result = tested.result;
  else if (testMutation.isError && testMutation.variables === selectedModel) {
    result = { ok: false, error: { code: 'test_request_failed', recoverable: true } };
  }
  let resultMessage: string | undefined;
  if (result?.ok) resultMessage = m['dashboard.providers.editor.validate_success']();
  else if (result?.error.code === 'invalid_draft') resultMessage = m['dashboard.providers.editor.validate_invalid']();
  else if (result !== null)
    resultMessage = m['dashboard.providers.editor.validate_failed']({ code: result.error.code });

  return (
    <section className="space-y-5" aria-labelledby="provider-validate-heading">
      <div className="space-y-1">
        <h2 id="provider-validate-heading" className="text-base font-semibold">
          {m['dashboard.providers.editor.step_validate']()}
        </h2>
        <p className="text-sm text-muted-foreground">{m['dashboard.providers.editor.validate_description']()}</p>
      </div>
      {selectedModel === undefined ? (
        <p role="status" className="rounded-lg border bg-muted p-3 text-sm">
          {m['dashboard.providers.editor.validate_unavailable']()}
        </p>
      ) : (
        <form.Field name="validationModel">
          {(field) => (
            <Field>
              <Label htmlFor="provider-validation-model">{m['dashboard.providers.editor.validate_model']()}</Label>
              <Select
                value={selectedModel}
                disabled={testMutation.isPending}
                onValueChange={(value) => field.handleChange(value ?? undefined)}
              >
                <SelectTrigger id="provider-validation-model" className="w-full">
                  <SelectValue>{(value: string | null) => value ?? selectedModel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{m['dashboard.providers.editor.validate_description']()}</FieldDescription>
            </Field>
          )}
        </form.Field>
      )}
      <Button
        type="button"
        disabled={selectedModel === undefined || testMutation.isPending}
        onClick={() => selectedModel !== undefined && testMutation.mutate(selectedModel)}
      >
        {testMutation.isPending
          ? m['dashboard.providers.editor.validate_pending']()
          : m['dashboard.providers.editor.validate_action']()}
      </Button>
      {result === null ? null : (
        <p role={result.ok ? 'status' : 'alert'} className="rounded-lg border bg-muted p-3 text-sm">
          {resultMessage}
        </p>
      )}
    </section>
  );
};
