import { m } from '@aio-proxy/i18n';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@aio-proxy/ui/components/select';
import { useId } from 'react';
import type React from 'react';
import type { FullOption, FullOptionList, ValueSelectorProps } from 'react-querybuilder';
import { isOptionGroupArray } from 'react-querybuilder';

import { getRequestTransformExpressionControlLabel } from './request-transform-condition-metadata';

export type TransformFieldKind =
  | 'provider.id'
  | 'provider.kind'
  | 'provider.protocol'
  | 'request.model'
  | 'request.requestedModel'
  | 'request.sourceProtocol'
  | 'request.targetProtocol'
  | 'request.method'
  | 'request.url'
  | 'request.body:'
  | 'original.body:'
  | 'request.header:'
  | 'original.header:';

export interface RequestTransformFieldSelectorProps extends ValueSelectorProps {}

const dynamicKinds = ['request.body:', 'original.body:', 'request.header:', 'original.header:'] as const;

const splitField = (value: string): { kind: TransformFieldKind; suffix: string } => {
  const dynamicKind = dynamicKinds.find((kind) => value.startsWith(kind));
  return dynamicKind === undefined
    ? { kind: value as TransformFieldKind, suffix: '' }
    : { kind: dynamicKind, suffix: value.slice(dynamicKind.length) };
};

const suffixLabel = (kind: TransformFieldKind): string => {
  if (kind === 'request.body:') return m['dashboard.providers.transforms.condition.field.current_body_path']();
  if (kind === 'original.body:') return m['dashboard.providers.transforms.condition.field.original_body_path']();
  if (kind === 'request.header:') return m['dashboard.providers.transforms.condition.field.current_header_name']();
  return m['dashboard.providers.transforms.condition.field.original_header_name']();
};

export const RequestTransformFieldSelector: React.FC<RequestTransformFieldSelectorProps> = ({
  className,
  options,
  value,
  disabled,
  testID = 'fields',
  ...props
}) => {
  const kindId = useId();
  const suffixId = useId();
  const { kind, suffix } = splitField(String(value ?? ''));
  const optionList = options as FullOptionList<FullOption>;
  const dynamic = dynamicKinds.includes(kind as (typeof dynamicKinds)[number]);
  const title = getRequestTransformExpressionControlLabel(
    testID,
    m['dashboard.providers.transforms.condition.field.title'](),
  );
  const suffixTitle = getRequestTransformExpressionControlLabel(testID, suffixLabel(kind));
  const selectedLabel = isOptionGroupArray(optionList)
    ? optionList.flatMap((group) => group.options).find((option) => option.name === kind)?.label
    : optionList.find((option) => option.name === kind)?.label;

  const renderOptions = (items: FullOption[]) =>
    items.map((option) => (
      <SelectItem key={option.name} value={option.name} disabled={option.disabled}>
        {option.label}
      </SelectItem>
    ));

  return (
    <span data-testid={testID} className="inline-flex min-w-0 items-center gap-2">
      <Label htmlFor={kindId} className="sr-only">
        {title}
      </Label>
      <Select
        value={kind}
        disabled={disabled}
        onValueChange={(nextKind) => props.handleOnChange(String(nextKind ?? ''))}
      >
        <SelectTrigger
          id={kindId}
          data-testid={`${testID}-kind`}
          className={className}
          title={title}
          aria-label={title}
        >
          <SelectValue>{() => selectedLabel ?? kind}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {isOptionGroupArray(optionList)
            ? optionList.map((group) => (
                <SelectGroup key={String(group.label)}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {renderOptions(group.options)}
                </SelectGroup>
              ))
            : renderOptions(optionList)}
        </SelectContent>
      </Select>
      {dynamic ? (
        <span className="min-w-36 flex-1">
          <Label htmlFor={suffixId} className="sr-only">
            {suffixTitle}
          </Label>
          <Input
            id={suffixId}
            data-testid={`${testID}-suffix`}
            value={suffix}
            disabled={disabled}
            title={suffixTitle}
            aria-label={suffixTitle}
            onChange={(event) => {
              const nextSuffix = kind.endsWith('header:') ? event.target.value.toLowerCase() : event.target.value;
              props.handleOnChange(`${kind}${nextSuffix}`);
            }}
          />
        </span>
      ) : null}
    </span>
  );
};
