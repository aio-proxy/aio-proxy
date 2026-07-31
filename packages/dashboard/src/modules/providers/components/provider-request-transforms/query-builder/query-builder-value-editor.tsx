import { m } from '@aio-proxy/i18n';
import { useId } from 'react';
import type React from 'react';
import type { ValueEditorProps, ValueSelectorProps } from 'react-querybuilder';
import { getFirstOption, parseNumber, useValueEditor } from 'react-querybuilder';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

export interface QueryBuilderValueEditorProps extends ValueEditorProps {
  readonly extraProps?: Record<string, unknown>;
}

type ValueEditorState = ReturnType<typeof useValueEditor>;

const regexValue = (value: unknown): { regex: string; options: string } => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { regex: '', options: '' };
  const document = value as Record<string, unknown>;
  return {
    regex: typeof document['regex'] === 'string' ? document['regex'] : '',
    options: typeof document['options'] === 'string' ? document['options'] : '',
  };
};

const editorTitle = (props: QueryBuilderValueEditorProps): string | undefined =>
  props.testID?.endsWith('-value') ? m['dashboard.providers.transforms.condition.value.title']() : props.title;

const renderBetweenEditor = (
  allProps: QueryBuilderValueEditorProps,
  state: ValueEditorState,
): React.ReactNode | undefined => {
  if (
    (allProps.operator !== 'between' && allProps.operator !== 'notBetween') ||
    (allProps.type !== 'select' && allProps.type !== 'text')
  ) {
    return undefined;
  }

  const SelectorComponent = allProps.selectorComponent ?? allProps.schema.controls.valueSelector;
  const values = allProps.values ?? [];
  const placeholder = allProps.fieldData?.placeholder ?? '';
  const title = editorTitle(allProps);
  const editors = ['from', 'to'].map((key, index) => {
    if (allProps.type === 'text') {
      return (
        <Input
          key={key}
          type={state.inputTypeCoerced}
          placeholder={placeholder}
          value={state.valueAsArray[index] ?? ''}
          className={state.valueListItemClassName}
          disabled={allProps.disabled}
          aria-label={title}
          onChange={(event) => state.multiValueHandler(event.target.value, index)}
          {...allProps.extraProps}
        />
      );
    }
    const selectorProps = {
      schema: allProps.schema,
      path: allProps.path,
      level: allProps.level,
      className: state.valueListItemClassName,
      handleOnChange: (nextValue: unknown) => state.multiValueHandler(nextValue, index),
      value: state.valueAsArray[index] ?? getFirstOption(values),
      options: values,
      ...(allProps.context === undefined ? {} : { context: allProps.context }),
      ...(allProps.validation === undefined ? {} : { validation: allProps.validation }),
      ...(allProps.disabled === undefined ? {} : { disabled: allProps.disabled }),
      ...(allProps.listsAsArrays === undefined ? {} : { listsAsArrays: allProps.listsAsArrays }),
    } satisfies ValueSelectorProps;
    return <SelectorComponent key={key} {...selectorProps} />;
  });

  return (
    <span data-testid={allProps.testID} className={allProps.className} title={title}>
      {editors[0]}
      {allProps.separator}
      {editors[1]}
    </span>
  );
};

const renderStandardEditor = (allProps: QueryBuilderValueEditorProps, state: ValueEditorState): React.ReactNode => {
  const testID = allProps.testID ?? 'value-editor';
  const placeholder = allProps.fieldData?.placeholder ?? '';
  const title = editorTitle(allProps);
  if (allProps.type === 'select' || allProps.type === 'multiselect') {
    const SelectorComponent = allProps.selectorComponent ?? allProps.schema.controls.valueSelector;
    const selectorProps = {
      schema: allProps.schema,
      path: allProps.path,
      level: allProps.level,
      className: allProps.className ?? '',
      testID,
      handleOnChange: (nextValue: unknown) => allProps.handleOnChange(nextValue),
      value: allProps.value,
      options: allProps.values ?? [],
      multiple: allProps.type === 'multiselect',
      ...(title === undefined ? {} : { title }),
      ...(allProps.context === undefined ? {} : { context: allProps.context }),
      ...(allProps.validation === undefined ? {} : { validation: allProps.validation }),
      ...(allProps.disabled === undefined ? {} : { disabled: allProps.disabled }),
      ...(allProps.listsAsArrays === undefined ? {} : { listsAsArrays: allProps.listsAsArrays }),
    } satisfies ValueSelectorProps;
    return <SelectorComponent {...selectorProps} />;
  }
  if (allProps.type === 'textarea') {
    return (
      <Textarea
        data-testid={testID}
        className={allProps.className}
        value={allProps.value}
        title={title}
        aria-label={title}
        placeholder={placeholder}
        disabled={allProps.disabled}
        onChange={(event) => allProps.handleOnChange(event.target.value)}
        {...allProps.extraProps}
      />
    );
  }
  if (allProps.type === 'switch' || allProps.type === 'checkbox') {
    const Control = allProps.type === 'switch' ? Switch : Checkbox;
    return (
      <Control
        data-testid={testID}
        className={allProps.className}
        title={title}
        aria-label={title}
        checked={!!allProps.value}
        disabled={allProps.disabled}
        onCheckedChange={(nextChecked) => allProps.handleOnChange(nextChecked)}
        {...allProps.extraProps}
      />
    );
  }
  if (allProps.inputType === 'bigint') {
    return (
      <Input
        data-testid={testID}
        type={state.inputTypeCoerced}
        placeholder={placeholder}
        value={`${allProps.value}`}
        title={title}
        aria-label={title}
        className={allProps.className}
        disabled={allProps.disabled}
        onChange={(event) => state.bigIntValueHandler(event.target.value)}
        {...allProps.extraProps}
      />
    );
  }
  return (
    <Input
      data-testid={testID}
      type={state.inputTypeCoerced}
      placeholder={placeholder}
      value={allProps.value ?? ''}
      title={title}
      aria-label={title}
      className={allProps.className}
      disabled={allProps.disabled}
      onChange={(event) =>
        allProps.handleOnChange(parseNumber(event.target.value, { parseNumbers: state.parseNumberMethod }))
      }
      {...allProps.extraProps}
    />
  );
};

export const QueryBuilderValueEditor: React.FC<QueryBuilderValueEditorProps> = (allProps) => {
  const regexId = useId();
  const optionsId = useId();
  const state = useValueEditor(allProps);
  const testID = allProps.testID ?? 'value-editor';

  if (['null', 'notNull', 'exists', 'doesNotExist'].includes(allProps.operator)) return null;

  if (allProps.operator === 'regex') {
    const regex = regexValue(allProps.value);
    const regexLabel = m['dashboard.providers.transforms.condition.regex.source']();
    const optionsLabel = m['dashboard.providers.transforms.condition.regex.flags']();
    return (
      <span data-testid={testID} className="inline-flex min-w-0 items-center gap-2" title={allProps.title}>
        <span className="min-w-40 flex-1">
          <Label htmlFor={regexId} className="sr-only">
            {regexLabel}
          </Label>
          <Input
            id={regexId}
            data-testid={`${testID}-regex`}
            value={regex.regex}
            disabled={allProps.disabled}
            title={regexLabel}
            aria-label={regexLabel}
            onChange={(event) => allProps.handleOnChange({ ...regex, regex: event.target.value })}
          />
        </span>
        <span className="w-24">
          <Label htmlFor={optionsId} className="sr-only">
            {optionsLabel}
          </Label>
          <Input
            id={optionsId}
            data-testid={`${testID}-options`}
            value={regex.options}
            disabled={allProps.disabled}
            title={optionsLabel}
            aria-label={optionsLabel}
            onChange={(event) => allProps.handleOnChange({ ...regex, options: event.target.value })}
          />
        </span>
      </span>
    );
  }

  return renderBetweenEditor(allProps, state) ?? renderStandardEditor(allProps, state);
};
