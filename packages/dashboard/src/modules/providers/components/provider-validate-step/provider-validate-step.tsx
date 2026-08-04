import { m } from '@aio-proxy/i18n';
import { type DashboardProviderDraftTestResponse, DashboardProviderDraftSchema } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldDescription } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useSelector } from '@tanstack/react-store';
import { useState } from 'react';

import { normalizeProviderFormValue, type ProviderForm } from '../../hooks/use-provider-form';
import { testProviderDraftModel } from '../../services/provider-draft';

interface ProviderValidateStepProps {
  readonly form: ProviderForm;
  readonly persistedProviderId?: string;
}

export const ProviderValidateStep: React.FC<ProviderValidateStepProps> = ({ form, persistedProviderId }) => {
  const values = useSelector(form.store, (state) => state.values);
  const models = values.models ?? [];
  const configuredModel = values.validationModel;
  const selectedModel = configuredModel !== undefined && models.includes(configuredModel) ? configuredModel : models[0];
  const [isPending, setIsPending] = useState(false);
  const [result, setResult] = useState<DashboardProviderDraftTestResponse | null>(null);

  const runTest = async () => {
    if (selectedModel === undefined) return;
    const draft = DashboardProviderDraftSchema.safeParse(normalizeProviderFormValue(values));
    if (!draft.success) {
      setResult({ ok: false, error: { code: 'invalid_draft', recoverable: true } });
      return;
    }
    setIsPending(true);
    try {
      setResult(
        await testProviderDraftModel({
          draft: draft.data,
          model: selectedModel,
          ...(persistedProviderId === undefined ? {} : { persistedProviderId }),
        }),
      );
    } catch {
      setResult({ ok: false, error: { code: 'test_request_failed', recoverable: true } });
    } finally {
      setIsPending(false);
    }
  };

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
              <Select value={selectedModel} onValueChange={(value) => field.handleChange(value ?? undefined)}>
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
      <Button type="button" disabled={selectedModel === undefined || isPending} onClick={() => void runTest()}>
        {isPending
          ? m['dashboard.providers.editor.validate_pending']()
          : m['dashboard.providers.editor.validate_action']()}
      </Button>
      {result === null ? null : (
        <p role="status" className="rounded-lg border bg-muted p-3 text-sm">
          {result.ok
            ? m['dashboard.providers.editor.validate_success']()
            : result.error.code === 'invalid_draft'
              ? m['dashboard.providers.editor.validate_invalid']()
              : m['dashboard.providers.editor.validate_failed']({ code: result.error.code })}
        </p>
      )}
    </section>
  );
};
