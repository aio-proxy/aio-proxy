import { m } from '@aio-proxy/i18n';
import { Field } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import type { AnyFieldApi } from '@tanstack/react-form';

import { proxyModeLabel, proxyModeOf, type ProxyMode } from '../../lib/advanced-summary';

interface ProviderProxyFieldProps {
  readonly field: AnyFieldApi;
}

export const ProviderProxyField: React.FC<ProviderProxyFieldProps> = ({ field }) => {
  const proxyMode = proxyModeOf(field.state.value);
  const modeId = `${field.name}-mode`;
  const urlId = `${field.name}-url`;

  const changeMode = (next: ProxyMode) => {
    if (next === 'inherit') field.handleChange(null);
    else if (next === 'disabled') field.handleChange(false);
    else field.handleChange('');
  };

  return (
    <div data-testid="provider-form-field-proxy" className="space-y-4">
      <Field>
        <Label htmlFor={modeId}>{m['dashboard.providers.form.label_proxy']()}</Label>
        <Select value={proxyMode} onValueChange={(value) => changeMode(value as ProxyMode)}>
          <SelectTrigger id={modeId} className="w-full sm:w-72">
            <SelectValue>{() => proxyModeLabel(field.state.value)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{m['dashboard.providers.form.proxy_inherit']()}</SelectItem>
            <SelectItem value="disabled">{m['dashboard.providers.form.proxy_disabled']()}</SelectItem>
            <SelectItem value="url">{m['dashboard.providers.form.proxy_url']()}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {proxyMode === 'url' ? (
        <Field>
          <Label htmlFor={urlId}>{m['dashboard.providers.form.label_proxy_url']()}</Label>
          <Input
            id={urlId}
            value={typeof field.state.value === 'string' ? field.state.value : ''}
            onChange={(event) => field.handleChange(event.target.value)}
            placeholder={m['dashboard.providers.form.placeholder_proxy_url']()}
            className="font-mono"
          />
        </Field>
      ) : null}
    </div>
  );
};
