import { m } from '@aio-proxy/i18n';
import { ProviderKind, type DashboardProviderDraftTestResponse } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Spinner } from '@aio-proxy/ui/components/spinner';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useSelector } from '@tanstack/react-store';
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react';

import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { useProviderTestMutation } from '../../../hooks/use-provider-test-mutation';

interface ModelValidationPanelProps {
  readonly form: ProviderEditorForm;
  readonly kind: ProviderKind;
  readonly persistedProviderId: string | undefined;
  readonly testableModels: readonly string[];
}

export const ModelValidationPanel: React.FC<ModelValidationPanelProps> = ({
  form,
  kind,
  persistedProviderId,
  testableModels,
}) => {
  const values = useSelector(form.store, (state) => state.values);
  const configuredModel = values.validationModel;
  const selectedModel =
    configuredModel !== undefined && testableModels.includes(configuredModel) ? configuredModel : testableModels[0];
  const testMutation = useProviderTestMutation(form, persistedProviderId);
  const tested = testMutation.data;
  let result: DashboardProviderDraftTestResponse | null = null;
  let resultMessage: string | undefined;
  if (tested !== undefined && tested.model === selectedModel) {
    result = tested.result;
    if (tested.result.ok) resultMessage = m['dashboard.providers.editor.validate_success']({ model: tested.model });
  } else if (testMutation.isError && testMutation.variables === selectedModel) {
    result = { ok: false, error: { code: 'test_request_failed', recoverable: true } };
  }
  if (result !== null && !result.ok)
    resultMessage =
      result.error.code === 'invalid_draft'
        ? m['dashboard.providers.editor.validate_invalid']()
        : m['dashboard.providers.editor.validate_failed']({ code: result.error.code });

  return (
    <section className="space-y-4" aria-labelledby="provider-validate-heading">
      <div className="space-y-1">
        <h2 id="provider-validate-heading" className="font-heading text-sm font-medium">
          {m['dashboard.providers.editor.validate_title']()}
        </h2>
        <p className="text-xs text-muted-foreground">{m['dashboard.providers.editor.validate_description']()}</p>
      </div>
      {selectedModel === undefined ? (
        <p role="status" className="rounded-2xl bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
          {m['dashboard.providers.editor.validate_unavailable']()}
        </p>
      ) : (
        <div className="space-y-3">
          <form.Field name="validationModel">
            {(field) => (
              <Select
                value={selectedModel}
                disabled={testMutation.isPending}
                onValueChange={(value) => field.handleChange(value ?? undefined)}
              >
                <SelectTrigger
                  className="w-full min-w-0 font-mono"
                  aria-label={m['dashboard.providers.editor.validate_model']()}
                >
                  <SelectValue>{(value: string | null) => value ?? selectedModel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {testableModels.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </form.Field>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={testMutation.isPending}
            onClick={() => testMutation.mutate(selectedModel)}
          >
            {testMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
            {m['dashboard.providers.editor.validate_action']()}
          </Button>
          {kind === ProviderKind.OAuth ? (
            <p className="text-xs text-muted-foreground">
              {m['dashboard.providers.editor.test_checks_saved_account']()}
            </p>
          ) : null}
        </div>
      )}
      {result === null ? null : (
        <p
          role={result.ok ? 'status' : 'alert'}
          className={cn('flex items-start gap-1.5 text-xs', result.ok ? 'text-muted-foreground' : 'text-destructive')}
        >
          {result.ok ? (
            <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
          ) : (
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          )}
          {resultMessage}
        </p>
      )}
    </section>
  );
};
