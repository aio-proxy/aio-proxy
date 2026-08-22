import { m } from '@aio-proxy/i18n';
import { Field } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Switch } from '@aio-proxy/ui/components/switch';
import type React from 'react';
import { useEffect, useRef } from 'react';

import type { useProviderForm } from '../hooks/use-provider-form';
import { useProviderOptionsSchema } from '../hooks/use-provider-options-schema';
import { type ProviderFormMode, type ProviderFormStep } from '../lib/constants';
import type { ProviderEditRouting } from '../services/providers-service';
import { ProviderAliasFields } from './provider-alias';
import { ProviderCommonFields } from './provider-common-fields';
import { ProviderModelsField } from './provider-models-field';
import { ProviderOptionsEditor } from './provider-options-editor';
import { ProviderProxyField } from './provider-proxy-field';
import { ProviderRequestTransformsFormField } from './provider-request-transforms';

const DEFAULT_AI_SDK_PACKAGE = '@ai-sdk/openai-compatible';

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
  form: ReturnType<typeof useProviderForm>;
  mode: ProviderFormMode;
  providerId?: string | undefined;
  activeStep?: ProviderFormStep;
  aliasOpen: boolean;
  onAliasOpenChange: (open: boolean) => void;
  onOptionsValidityChange: (valid: boolean) => void;
  onTransformsValidityChange: (valid: boolean) => void;
  routing?: ProviderEditRouting;
}

export const ProviderFormFieldsAiSdk: React.FC<ProviderFormFieldsAiSdkProps> = ({
  form,
  mode,
  providerId,
  activeStep = 0,
  aliasOpen,
  onAliasOpenChange,
  onOptionsValidityChange,
  onTransformsValidityChange,
  routing,
}) => {
  const schemaState = useProviderOptionsSchema();
  const initialPackageName = useRef<string | undefined>(undefined);
  const initialPackageSynchronized = useRef(false);
  const lastCommittedPackage = useRef<string | null>(null);
  const commitUserPackage = (packageName: string) =>
    commitProviderPackageOnce(packageName, lastCommittedPackage, (nextPackageName) =>
      schemaState.commitPackage(nextPackageName, true),
    );

  useEffect(() => {
    if (initialPackageSynchronized.current) return;
    initialPackageSynchronized.current = true;
    initialPackageName.current = form.getFieldValue('packageName') ?? DEFAULT_AI_SDK_PACKAGE;
    schemaState.commitPackage(initialPackageName.current, false);
  }, [form, schemaState.commitPackage]);

  if (activeStep === 0) {
    return (
      <section className="space-y-5" aria-labelledby="provider-ai-sdk-connection-heading">
        <h2 id="provider-ai-sdk-connection-heading" className="text-base font-semibold">
          {m['dashboard.providers.editor.step_connection']()}
        </h2>
        <ProviderCommonFields form={form} mode={mode} section="connection" />
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
                onValidityChange={onOptionsValidityChange}
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
        <form.Field name="proxy">{(field) => <ProviderProxyField field={field} mode={mode} />}</form.Field>
      </section>
    );
  }

  if (activeStep === 1) {
    return (
      <section className="space-y-5" aria-labelledby="provider-ai-sdk-models-heading">
        <h2 id="provider-ai-sdk-models-heading" className="text-base font-semibold">
          {m['dashboard.providers.editor.step_models']()}
        </h2>
        <ProviderModelsField form={form} {...(providerId === undefined ? {} : { persistedProviderId: providerId })} />
        <ProviderAliasFields form={form} mode={mode} open={aliasOpen} onOpenChange={onAliasOpenChange} />
      </section>
    );
  }

  if (activeStep === 2) {
    return (
      <section className="space-y-5" aria-labelledby="provider-ai-sdk-routing-heading">
        <h2 id="provider-ai-sdk-routing-heading" className="text-base font-semibold">
          {m['dashboard.providers.editor.step_routing']()}
        </h2>
        <ProviderCommonFields
          form={form}
          mode={mode}
          section="routing"
          {...(routing === undefined ? {} : { routing })}
        />
        <ProviderRequestTransformsFormField form={form} onValidityChange={onTransformsValidityChange} />
      </section>
    );
  }

  return null;
};
