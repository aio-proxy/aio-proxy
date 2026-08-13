import { m } from '@aio-proxy/i18n';
import { Field } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Switch } from '@aio-proxy/ui/components/switch';
import type React from 'react';
import { useEffect, useRef } from 'react';

import type { ProviderEditorForm } from '../hooks/use-provider-editor-form';
import { useProviderOptionsSchema } from '../hooks/use-provider-options-schema';
import { ProviderOptionsEditor } from './provider-options-editor';

const DEFAULT_AI_SDK_PACKAGE = '@ai-sdk/openai-compatible';

const IGNORE_VALIDITY = () => undefined;

type PackageCommitRef = { current: string | null };

export const commitProviderPackageOnce = (
  packageName: string,
  lastCommitted: PackageCommitRef,
  commitPackage: (packageName: string) => void,
) => {
  if (lastCommitted.current === packageName) return false;
  lastCommitted.current = packageName;
  commitPackage(packageName);
  return true;
};

interface ProviderFormFieldsAiSdkProps {
  form: ProviderEditorForm;
  onOptionsValidityChange?: ((valid: boolean) => void) | undefined;
}

export const ProviderFormFieldsAiSdk: React.FC<ProviderFormFieldsAiSdkProps> = ({ form, onOptionsValidityChange }) => {
  const schemaState = useProviderOptionsSchema();
  const initialPackageSynchronized = useRef(false);
  const lastCommittedPackage = useRef<string | null>(null);
  const commitUserPackage = (packageName: string) =>
    commitProviderPackageOnce(packageName, lastCommittedPackage, (nextPackageName) =>
      schemaState.commitPackage(nextPackageName, true),
    );

  useEffect(() => {
    if (initialPackageSynchronized.current) return;
    initialPackageSynchronized.current = true;
    schemaState.commitPackage(form.getFieldValue('packageName') ?? DEFAULT_AI_SDK_PACKAGE, false);
  }, [form, schemaState.commitPackage]);

  return (
    <>
      <div data-testid="provider-form-field-packageName">
        <form.Field name="packageName">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m['dashboard.providers.form.label_package_name']()}</Label>
              <Input
                id={field.name}
                value={field.state.value ?? DEFAULT_AI_SDK_PACKAGE}
                onChange={(event) => {
                  field.handleChange(event.target.value);
                  lastCommittedPackage.current = null;
                  schemaState.changePackage(event.target.value);
                }}
                onBlur={() => commitUserPackage(field.state.value ?? DEFAULT_AI_SDK_PACKAGE)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitUserPackage(field.state.value ?? DEFAULT_AI_SDK_PACKAGE);
                  }
                }}
                placeholder={DEFAULT_AI_SDK_PACKAGE}
              />
            </Field>
          )}
        </form.Field>
      </div>
      <div data-testid="provider-form-field-options">
        <form.Field name="options">
          {(field) => (
            <ProviderOptionsEditor
              field={field}
              schemaState={schemaState}
              onValidityChange={onOptionsValidityChange ?? IGNORE_VALIDITY}
            />
          )}
        </form.Field>
      </div>
      <div data-testid="provider-form-field-parseReasoningContent">
        <form.Field name="parseReasoningContent">
          {(field) => (
            <Field>
              <div className="flex items-center gap-2">
                <Switch
                  id={field.name}
                  checked={field.state.value ?? false}
                  onCheckedChange={(checked) => field.handleChange(Boolean(checked))}
                />
                <Label htmlFor={field.name}>{m['dashboard.providers.form.label_parse_reasoning']()}</Label>
              </div>
            </Field>
          )}
        </form.Field>
      </div>
    </>
  );
};
