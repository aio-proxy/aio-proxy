import { m } from '@aio-proxy/i18n';
import { ProviderProtocol } from '@aio-proxy/types';
import { Field } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';

import { ProtocolLabel } from '@/components/protocol-label';

import type { useProviderForm } from '../hooks/use-provider-form';
import { ProviderFormMode, type ProviderFormStep } from '../lib/constants';
import { ProviderAliasFields } from './provider-alias';
import { ProviderCommonFields } from './provider-common-fields';
import { ProviderHeadersField } from './provider-headers-field';
import { ProviderModelsField } from './provider-models-field';
import { ProviderProxyField } from './provider-proxy-field';
import { ProviderRequestTransformsFormField } from './provider-request-transforms';

interface ProviderFormFieldsApiProps {
  form: ReturnType<typeof useProviderForm>;
  mode: ProviderFormMode;
  providerId?: string | undefined;
  activeStep?: ProviderFormStep;
  aliasOpen: boolean;
  onAliasOpenChange: (open: boolean) => void;
  onTransformsValidityChange: (valid: boolean) => void;
}

export const ProviderFormFieldsApi: React.FC<ProviderFormFieldsApiProps> = ({
  form,
  mode,
  providerId,
  activeStep = 0,
  aliasOpen,
  onAliasOpenChange,
  onTransformsValidityChange,
}) => {
  if (activeStep === 0) {
    return (
      <section className="space-y-5" aria-labelledby="provider-api-connection-heading">
        <h2 id="provider-api-connection-heading" className="text-base font-semibold">
          {m['dashboard.providers.editor.step_connection']()}
        </h2>
        <ProviderCommonFields form={form} mode={mode} section="connection" />
        <div data-testid="provider-form-field-protocol">
          <form.Field name="protocol">
            {(field) => (
              <Field>
                <Label>{m['dashboard.providers.form.label_protocol']()}</Label>
                <Select
                  value={field.state.value ?? ''}
                  onValueChange={(v) => field.handleChange(v as ProviderProtocol)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={m['dashboard.providers.form.placeholder_protocol']()}>
                      {(protocol: ProviderProtocol | null) =>
                        protocol ? (
                          <ProtocolLabel protocol={protocol} showIcon />
                        ) : (
                          m['dashboard.providers.form.placeholder_protocol']()
                        )
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(ProviderProtocol).map((protocol) => (
                      <SelectItem key={protocol} value={protocol}>
                        <ProtocolLabel protocol={protocol} showIcon />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>
        </div>
        <div data-testid="provider-form-field-baseURL">
          <form.Field name="baseURL">
            {(field) => (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.providers.form.label_base_url']()}</Label>
                <Input
                  id={field.name}
                  value={field.state.value ?? ''}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder={m['dashboard.providers.form.placeholder_base_url']()}
                />
              </Field>
            )}
          </form.Field>
        </div>
        <div data-testid="provider-form-field-apiKey">
          <form.Field name="apiKey">
            {(field) => (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.providers.form.label_api_key']()}</Label>
                <Input
                  id={field.name}
                  type="password"
                  value={field.state.value ?? ''}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder={m['dashboard.providers.form.placeholder_api_key']()}
                />
                <p className="text-sm text-muted-foreground">
                  {mode === ProviderFormMode.Edit
                    ? m['dashboard.providers.form.api_key_helper_edit']()
                    : m['dashboard.providers.form.api_key_helper_create']()}
                </p>
              </Field>
            )}
          </form.Field>
        </div>
        <form.Field name="proxy">{(field) => <ProviderProxyField field={field} mode={mode} />}</form.Field>
        <form.Field name="headers">
          {(field) => <ProviderHeadersField value={field.state.value} onChange={field.handleChange} />}
        </form.Field>
      </section>
    );
  }

  if (activeStep === 1) {
    return (
      <section className="space-y-5" aria-labelledby="provider-api-models-heading">
        <h2 id="provider-api-models-heading" className="text-base font-semibold">
          {m['dashboard.providers.editor.step_models']()}
        </h2>
        <ProviderModelsField form={form} {...(providerId === undefined ? {} : { persistedProviderId: providerId })} />
        <ProviderAliasFields form={form} mode={mode} open={aliasOpen} onOpenChange={onAliasOpenChange} />
      </section>
    );
  }

  if (activeStep === 2) {
    return (
      <section className="space-y-5" aria-labelledby="provider-api-routing-heading">
        <h2 id="provider-api-routing-heading" className="text-base font-semibold">
          {m['dashboard.providers.editor.step_routing']()}
        </h2>
        <ProviderCommonFields form={form} mode={mode} section="routing" />
        <ProviderRequestTransformsFormField form={form} onValidityChange={onTransformsValidityChange} />
      </section>
    );
  }

  return null;
};
