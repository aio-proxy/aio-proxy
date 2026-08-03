import { m } from '@aio-proxy/i18n';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@aio-proxy/ui/components/select';
import { useMemo } from 'react';
import type React from 'react';
import type { FullOption, FullOptionList, VersatileSelectorProps } from 'react-querybuilder';
import { isOptionGroupArray, useValueSelector } from 'react-querybuilder';

import { RequestTransformFieldSelector } from '../request-transform-field-selector';

export const REQUEST_TRANSFORM_SET_EXPRESSION_TEST_ID = 'transform-set-expression';

export interface QueryBuilderValueSelectorProps extends VersatileSelectorProps {}

const optionName = (option: FullOption): string => String(option.value ?? option.name);

const expressionKindLabel = (name: string, fallback: string): string => {
  if (name === 'field') return m['dashboard.providers.transforms.condition.expression_kind.field']();
  if (name === 'value') return m['dashboard.providers.transforms.condition.expression_kind.value']();
  if (name === 'func') return m['dashboard.providers.transforms.condition.expression_kind.function']();
  return fallback;
};

const valueSourceLabel = (name: string, fallback: string): string => {
  if (name === 'value') return m['dashboard.providers.transforms.condition.value_source.value']();
  if (name === 'field') return m['dashboard.providers.transforms.condition.value_source.field']();
  if (name === 'expression') return m['dashboard.providers.transforms.condition.value_source.expression']();
  return fallback;
};

const transformOptions = (items: FullOption[], testID: string | undefined): FullOption[] => {
  if (testID?.endsWith('-kind')) {
    const setRoot = testID === `${REQUEST_TRANSFORM_SET_EXPRESSION_TEST_ID}-kind`;
    return items
      .filter((option) => optionName(option) !== 'parameter' && (!setRoot || optionName(option) !== 'value'))
      .map((option) => ({ ...option, label: expressionKindLabel(optionName(option), option.label) }));
  }
  if (testID === 'value-source-selector') {
    return items.map((option) => ({ ...option, label: valueSourceLabel(optionName(option), option.label) }));
  }
  return items;
};

const selectorTitle = (testID: string | undefined, fallback: string | undefined): string | undefined => {
  if (testID?.endsWith('-kind')) return m['dashboard.providers.transforms.condition.expression_kind.title']();
  if (testID?.endsWith('-fn')) return m['dashboard.providers.transforms.condition.function.title']();
  if (testID === 'value-source-selector') return m['dashboard.providers.transforms.condition.value_source.title']();
  return fallback;
};

export const QueryBuilderValueSelector: React.FC<QueryBuilderValueSelectorProps> = (allProps) => {
  const {
    className,
    options,
    value,
    title,
    disabled,
    multiple: _multiple,
    listsAsArrays: _listsAsArrays,
    testID,
    field: _field,
    fieldData: _fieldData,
    rule: _rule,
    ruleGroup: _ruleGroup,
    rules: _rules,
    path: _path,
    level: _level,
    context: _context,
    validation: _validation,
    schema: _schema,
    ...otherProps
  } = allProps;
  const { onChange, val } = useValueSelector({
    handleOnChange: (nextValue) => allProps.handleOnChange(nextValue),
    ...(value === undefined ? {} : { value }),
  });
  const localizedTitle = selectorTitle(testID, title);
  const optionList = useMemo(() => {
    const list = options as FullOptionList<FullOption>;
    if (isOptionGroupArray(list)) {
      return list.map((group) => ({ ...group, options: transformOptions(group.options, testID) }));
    }
    return transformOptions(list, testID);
  }, [options, testID]);

  if (testID?.endsWith('-field')) return <RequestTransformFieldSelector {...allProps} />;

  const selectedLabel = isOptionGroupArray(optionList)
    ? optionList.flatMap((group) => group.options).find((option) => option.name === val)?.label
    : optionList.find((option) => option.name === val)?.label;

  const renderOptions = (items: FullOption[]) =>
    items.map((option) => (
      <SelectItem key={option.name} value={option.name} disabled={option.disabled}>
        {option.label}
      </SelectItem>
    ));

  return (
    <Select
      {...otherProps}
      value={val as string}
      onValueChange={(nextValue) => {
        if (nextValue !== null) onChange(nextValue);
      }}
      disabled={disabled}
    >
      <SelectTrigger data-testid={testID} className={className} title={localizedTitle} aria-label={localizedTitle}>
        <SelectValue>{() => selectedLabel ?? String(val ?? '')}</SelectValue>
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
  );
};
