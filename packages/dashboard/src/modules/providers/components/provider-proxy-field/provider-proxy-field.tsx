import { m } from '@aio-proxy/i18n';
import { Field, FieldDescription } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import type { AnyFieldApi } from '@tanstack/react-form';
import { useRef } from 'react';

import { ProviderFormMode } from '../../constants';

type ProxyMode = 'unchanged' | 'inherit' | 'disabled' | 'url';

interface ProviderProxyFieldProps {
  readonly field: AnyFieldApi;
  readonly mode: ProviderFormMode;
}

const modeLabel = (mode: ProxyMode) => {
  switch (mode) {
    case 'unchanged':
      return m['dashboard.providers.form.proxy_unchanged']();
    case 'inherit':
      return m['dashboard.providers.form.proxy_inherit']();
    case 'disabled':
      return m['dashboard.providers.form.proxy_disabled']();
    case 'url':
      return m['dashboard.providers.form.proxy_url']();
  }
};

const selectedMode = (value: unknown, formMode: ProviderFormMode): ProxyMode => {
  if (value === '****' || (formMode === ProviderFormMode.Edit && value === undefined)) return 'unchanged';
  if (value === false) return 'disabled';
  if (typeof value === 'string') return 'url';
  return 'inherit';
};

export const ProviderProxyField: React.FC<ProviderProxyFieldProps> = ({ field, mode }) => {
  const initiallyRedacted = useRef(field.state.value === '****').current;
  const proxyMode = selectedMode(field.state.value, mode);
  const modeId = `${field.name}-mode`;
  const urlId = `${field.name}-url`;

  const changeMode = (next: ProxyMode) => {
    if (next === 'unchanged') field.handleChange(initiallyRedacted ? '****' : undefined);
    else if (next === 'inherit') field.handleChange(null);
    else if (next === 'disabled') field.handleChange(false);
    else field.handleChange('');
  };

  return (
    <div data-testid="provider-form-field-proxy">
      <Field>
        <Label htmlFor={modeId}>{m['dashboard.providers.form.label_proxy_mode']()}</Label>
        <Select value={proxyMode} onValueChange={(value) => changeMode(value as ProxyMode)}>
          <SelectTrigger id={modeId} className="w-full">
            <SelectValue>{(value: ProxyMode | null) => modeLabel(value ?? proxyMode)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {mode === ProviderFormMode.Edit ? (
              <SelectItem value="unchanged">{m['dashboard.providers.form.proxy_unchanged']()}</SelectItem>
            ) : null}
            <SelectItem value="inherit">{m['dashboard.providers.form.proxy_inherit']()}</SelectItem>
            <SelectItem value="disabled">{m['dashboard.providers.form.proxy_disabled']()}</SelectItem>
            <SelectItem value="url">{m['dashboard.providers.form.proxy_url']()}</SelectItem>
          </SelectContent>
        </Select>
        {proxyMode === 'url' ? (
          <div className="space-y-2">
            <Label htmlFor={urlId}>{m['dashboard.providers.form.proxy_url']()}</Label>
            <Input
              id={urlId}
              value={typeof field.state.value === 'string' && field.state.value !== '****' ? field.state.value : ''}
              onChange={(event) => field.handleChange(event.target.value)}
              placeholder={m['dashboard.providers.form.placeholder_proxy_url']()}
            />
          </div>
        ) : null}
        <FieldDescription>{m['dashboard.providers.form.proxy_helper']()}</FieldDescription>
      </Field>
    </div>
  );
};
