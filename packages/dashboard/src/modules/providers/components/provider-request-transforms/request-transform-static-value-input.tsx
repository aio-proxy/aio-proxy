import { m } from '@aio-proxy/i18n';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';

import { RequestTransformCompositeValueControl } from './request-transform-composite-value-control';

export type StaticValueType = 'text' | 'number' | 'boolean' | 'null' | 'object' | 'array';
export type InvalidStaticValueType = Extract<StaticValueType, 'number' | 'object' | 'array'>;

interface RequestTransformStaticValueInputProps {
  readonly type: Exclude<StaticValueType, 'null'>;
  readonly ruleName: string;
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

// The composite control names itself through `labelId`, so scoping this label covers it too.
const scopedStaticLabel = (ruleName: string): string =>
  m['dashboard.providers.transforms.value.scoped_label']({
    name: ruleName,
    label: m['dashboard.providers.transforms.value.static_label'](),
  });

export const RequestTransformStaticValueInput: React.FC<RequestTransformStaticValueInputProps> = ({
  type,
  ruleName,
  draft,
  valueId,
  errorId,
  error,
  onChange,
}) => {
  if (type === 'boolean') {
    // `sr-only` is absolutely positioned, so the label names the trigger without taking a grid track.
    return (
      <>
        <Label htmlFor={valueId} className="sr-only">
          {scopedStaticLabel(ruleName)}
        </Label>
        <Select value={draft} onValueChange={(next) => next !== null && onChange(next)}>
          <SelectTrigger id={valueId} data-testid="request-transform-static-boolean" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">true</SelectItem>
            <SelectItem value="false">false</SelectItem>
          </SelectContent>
        </Select>
      </>
    );
  }

  const labelId = `${valueId}-label`;
  const inputProps = {
    id: valueId,
    value: draft,
    'aria-invalid': error !== null,
    'aria-describedby': error === null ? undefined : errorId,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
  };
  return (
    <div className="min-w-0 space-y-2">
      <Label id={labelId} htmlFor={valueId} className="sr-only">
        {scopedStaticLabel(ruleName)}
      </Label>
      {type === 'object' || type === 'array' ? (
        <RequestTransformCompositeValueControl
          type={type}
          draft={draft}
          valueId={valueId}
          labelId={labelId}
          invalid={error !== null}
          describedBy={error === null ? undefined : errorId}
          onChange={onChange}
        />
      ) : (
        <Input
          {...inputProps}
          placeholder={type === 'text' ? m['dashboard.providers.transforms.value.placeholder_text']() : '0'}
          className="font-mono text-xs"
        />
      )}
      {error === null ? null : (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {validationMessage(error)}
        </p>
      )}
    </div>
  );
};
