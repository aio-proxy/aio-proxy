import { m } from '@aio-proxy/i18n';
import { Field, FieldDescription } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import { Switch } from '@aio-proxy/ui/components/switch';
import type React from 'react';
import { useEffect, useRef } from 'react';

import type { ProviderEditorForm } from '../hooks/use-provider-editor-form';
import { useProviderOptionsSchema } from '../hooks/use-provider-options-schema';
import { PROVIDER_AI_SDK_DEFAULT_PACKAGE as DEFAULT_AI_SDK_PACKAGE } from '../lib/constants';
import { ProviderOptionsEditor } from './provider-options-editor';
import { ProviderPackageCombobox } from './provider-package-combobox';

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
              <ProviderPackageCombobox
                id={field.name}
                value={field.state.value ?? DEFAULT_AI_SDK_PACKAGE}
                onValueChange={(packageName) => {
                  field.handleChange(packageName);
                  // Picking from the list also re-emits the picked text as an input change. Resetting
                  // on that echo would throw away the commit the pick just made, so it is ignored.
                  if (packageName === lastCommittedPackage.current) return;
                  lastCommittedPackage.current = null;
                  schemaState.changePackage(packageName);
                }}
                onCommit={commitUserPackage}
              />
              <FieldDescription>{m['dashboard.providers.form.package_name_description']()}</FieldDescription>
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
            // Same horizontal Field as the routing switch, rather than a nested flex row: the switch
            // then its label, on the vertical rhythm the two fields above sit on.
            <Field orientation="horizontal">
              <Switch
                id={field.name}
                checked={field.state.value ?? false}
                onCheckedChange={(checked) => field.handleChange(Boolean(checked))}
              />
              <Label htmlFor={field.name}>{m['dashboard.providers.form.label_parse_reasoning']()}</Label>
            </Field>
          )}
        </form.Field>
      </div>
    </>
  );
};
