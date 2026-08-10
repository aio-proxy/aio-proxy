import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';

interface PluginInstallInputFieldProps {
  readonly id: string;
  readonly label: string;
  readonly onBlur: () => void;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly type?: 'text' | 'url';
  readonly value: string;
}

export const PluginInstallInputField: React.FC<PluginInstallInputFieldProps> = ({
  id,
  label,
  onBlur,
  onChange,
  placeholder,
  type = 'text',
  value,
}) => (
  <Field>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <Input
      id={id}
      type={type}
      autoComplete="off"
      value={value}
      placeholder={placeholder}
      onBlur={onBlur}
      onChange={(event) => onChange(event.target.value)}
    />
  </Field>
);
