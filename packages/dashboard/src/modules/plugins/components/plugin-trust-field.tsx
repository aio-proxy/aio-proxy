import { m } from '@aio-proxy/i18n';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';

interface PluginTrustFieldProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

export const PluginTrustField: React.FC<PluginTrustFieldProps> = ({ checked, onChange }) => (
  <Field>
    <FieldLabel className="items-start">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      {m['dashboard.plugins.trust_local_code']()}
    </FieldLabel>
    <FieldDescription>{m['dashboard.plugins.trust_local_code_description']()}</FieldDescription>
  </Field>
);
