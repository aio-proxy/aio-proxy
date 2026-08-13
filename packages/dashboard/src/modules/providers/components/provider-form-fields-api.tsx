import { m } from '@aio-proxy/i18n';
import { ProviderProtocol } from '@aio-proxy/types';
import { Field } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';

import { ProtocolLabel } from '@/components/protocol-label';

import type { ProviderEditorForm } from '../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../lib/constants';

interface ProviderFormFieldsApiProps {
  form: ProviderEditorForm;
  mode: ProviderFormMode;
}

export const ProviderFormFieldsApi: React.FC<ProviderFormFieldsApiProps> = ({ form, mode }) => (
  <>
    <div data-testid="provider-form-field-protocol">
      <form.Field name="protocol">
        {(field) => (
          <Field>
            <Label>{m['dashboard.providers.form.label_protocol']()}</Label>
            <Select value={field.state.value ?? ''} onValueChange={(v) => field.handleChange(v as ProviderProtocol)}>
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
                ? m['dashboard.providers.editor.api_key_retained_hint']()
                : m['dashboard.providers.form.api_key_helper_create']()}
            </p>
          </Field>
        )}
      </form.Field>
    </div>
  </>
);
