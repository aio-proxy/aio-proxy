import { m } from '@aio-proxy/i18n';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Textarea } from '@aio-proxy/ui/components/textarea';

export type StaticValueType = 'text' | 'number' | 'boolean' | 'null' | 'object' | 'array';
export type InvalidStaticValueType = Extract<StaticValueType, 'number' | 'object' | 'array'>;

interface RequestTransformStaticValueInputProps {
  readonly type: Exclude<StaticValueType, 'null'>;
  readonly draft: string;
  readonly valueId: string;
  readonly errorId: string;
  readonly error: InvalidStaticValueType | null;
  readonly onChange: (draft: string) => void;
}

const validationMessage = (error: InvalidStaticValueType): string => {
  if (error === 'number') return m['dashboard.providers.transforms.value.invalid_number']();
  if (error === 'object') return m['dashboard.providers.transforms.value.invalid_object']();
  return m['dashboard.providers.transforms.value.invalid_array']();
};

export const RequestTransformStaticValueInput: React.FC<RequestTransformStaticValueInputProps> = ({
  type,
  draft,
  valueId,
  errorId,
  error,
  onChange,
}) => {
  if (type === 'boolean') {
    return (
      <Label className="w-fit">
        <Checkbox checked={draft === 'true'} onCheckedChange={(checked) => onChange(String(Boolean(checked)))} />
        {m['dashboard.providers.transforms.value.boolean_true']()}
      </Label>
    );
  }

  const inputProps = {
    id: valueId,
    value: draft,
    'aria-invalid': error !== null,
    'aria-describedby': error === null ? undefined : errorId,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };
  return (
    <div className="space-y-2">
      <Label htmlFor={valueId}>{m['dashboard.providers.transforms.value.static_label']()}</Label>
      {type === 'object' || type === 'array' ? (
        <Textarea {...inputProps} className="min-h-28 font-mono" />
      ) : (
        <Input {...inputProps} type={type === 'number' ? 'number' : 'text'} />
      )}
      {error === null ? null : (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {validationMessage(error)}
        </p>
      )}
    </div>
  );
};
