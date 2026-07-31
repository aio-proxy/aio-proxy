/* oxlint-disable max-lines, max-lines-per-function */

import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';

import { ProviderRequestTransformsEditor } from './provider-request-transforms-editor';

rs.mock('@/components/json-editor/json-schema-registry', () => ({
  registerJsonSchema: () => () => undefined,
  validateJsonModel: async () => [],
}));

rs.mock('@monaco-editor/react', () => ({
  Editor: ({ onChange, onMount, options, value }: any) => {
    const valueRef = useRef(value);
    const onMountRef = useRef(onMount);
    valueRef.current = value;
    useEffect(() => {
      onMountRef.current?.({ getDomNode: () => null, getModel: () => ({ getValue: () => valueRef.current }) }, {});
    }, []);
    return (
      <textarea aria-label={options?.ariaLabel} value={value} onChange={(event) => onChange?.(event.target.value)} />
    );
  },
}));

interface RequestTransformsHarnessProps {
  readonly initialValue: readonly ProviderRequestTransformRule[];
  readonly onChange: (value: readonly ProviderRequestTransformRule[]) => void;
  readonly onValidityChange: (valid: boolean) => void;
}

const RequestTransformsHarness: React.FC<RequestTransformsHarnessProps> = ({
  initialValue,
  onChange,
  onValidityChange,
}) => {
  const [value, setValue] = useState(initialValue);
  return (
    <ProviderRequestTransformsEditor
      value={value}
      onChange={(nextValue) => {
        setValue(nextValue);
        onChange(nextValue);
      }}
      onValidityChange={onValidityChange}
    />
  );
};

const initialValue = [
  {
    name: 'primary',
    update: [
      { $set: { 'request.body.value': { $literal: '$seed' } } },
      {
        $set: {
          'request.headers': {
            $setField: {
              field: 'x-route',
              input: '$request.headers',
              value: { $concat: ['$request.body.route', { $toUpper: ['$original.body.region'] }] },
            },
          },
        },
      },
      { $unset: 'request.body.value' },
      {
        $set: {
          'request.headers': {
            $unsetField: { field: 'x-route', input: '$request.headers' },
          },
        },
      },
    ],
  },
] satisfies readonly ProviderRequestTransformRule[];

const selectOption = async (trigger: HTMLElement, name: string | RegExp) => {
  fireEvent.click(trigger);
  const option = await screen.findByRole('option', { name });
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
};

const latestValue = (onChange: ReturnType<typeof rs.fn>) =>
  (onChange.mock.calls.at(-1)?.[0] ?? initialValue) as readonly ProviderRequestTransformRule[];

const ruleCard = (index: number) => screen.getByTestId(`request-transform-rule-${index}`);
const stageCard = (index: number) => within(ruleCard(0)).getByTestId(`request-transform-stage-${index}`);

test('edits ordered Set and Remove actions losslessly across Visual and JSON modes', async () => {
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  render(
    <RequestTransformsHarness initialValue={initialValue} onChange={onChange} onValidityChange={onValidityChange} />,
  );

  expect(within(ruleCard(0)).getByRole('textbox', { name: /Rule 1 name|规则 1 名称/u })).toHaveValue('primary');
  let stages = within(ruleCard(0)).getAllByTestId(/request-transform-stage-/u);
  expect(stages).toHaveLength(4);
  expect(within(stages[0]!).getByTestId('request-transform-action')).toHaveTextContent(/Set|设置/u);
  expect(within(stages[0]!).getByTestId('request-transform-target')).toHaveTextContent(/Body|请求体/u);
  expect(within(stages[0]!).getByRole('textbox', { name: /Body path|请求体路径/u })).toHaveValue('value');
  expect(within(stages[0]!).getByTestId('request-transform-value-mode')).toHaveTextContent(/Static|静态/u);
  expect(within(stages[0]!).getByRole('textbox', { name: /Static value|静态值/u })).toHaveValue('"$seed"');
  expect(within(stages[1]!).getByTestId('request-transform-target')).toHaveTextContent(/Header|请求头/u);
  expect(within(stages[1]!).getByRole('textbox', { name: /Header name|请求头名称/u })).toHaveValue('x-route');
  expect(within(stages[1]!).getByTestId('request-transform-value-mode')).toHaveTextContent(/Computed|计算/u);
  expect(within(stages[1]!).getByTestId('transform-set-expression-fn')).toHaveTextContent(/CONCAT/u);
  expect(within(stages[2]!).getByTestId('request-transform-action')).toHaveTextContent(/Remove|移除/u);
  expect(within(stages[2]!).getByRole('textbox', { name: /Body path|请求体路径/u })).toHaveValue('value');
  expect(within(stages[3]!).getByRole('textbox', { name: /Header name|请求头名称/u })).toHaveValue('x-route');

  fireEvent.click(screen.getByRole('button', { name: /Add rule|添加规则/u }));
  await waitFor(() => expect(screen.getAllByTestId(/request-transform-rule-/u)).toHaveLength(2));
  const addedRule = ruleCard(1);
  const addedPath = within(addedRule).getByRole('textbox', { name: /Body path|请求体路径/u });
  expect(document.activeElement).toBe(addedPath);
  expect((addedPath as HTMLInputElement).selectionStart).toBe(0);
  expect((addedPath as HTMLInputElement).selectionEnd).toBe('value'.length);
  expect(within(addedRule).getByRole('button', { name: /Remove action 1|删除操作 1/u })).toBeDisabled();
  fireEvent.change(within(addedRule).getByRole('textbox', { name: /Rule 2 name|规则 2 名称/u }), {
    target: { value: 'fallback' },
  });
  fireEvent.click(within(ruleCard(1)).getByRole('button', { name: /Move rule 2 up|上移规则 2/u }));
  await waitFor(() => expect(latestValue(onChange)[0]?.name).toBe('fallback'));
  fireEvent.click(within(ruleCard(0)).getByRole('button', { name: /Move rule 1 down|下移规则 1/u }));
  await waitFor(() => expect(latestValue(onChange)[1]?.name).toBe('fallback'));
  fireEvent.click(within(ruleCard(1)).getByRole('button', { name: /Remove rule 2|删除规则 2/u }));
  await waitFor(() => expect(screen.getAllByTestId(/request-transform-rule-/u)).toHaveLength(1));

  fireEvent.click(within(ruleCard(0)).getByRole('button', { name: /Add Set action|添加 Set 操作/u }));
  fireEvent.click(within(ruleCard(0)).getByRole('button', { name: /Add Remove action|添加 Remove 操作/u }));
  await waitFor(() => expect(latestValue(onChange)[0]?.update).toHaveLength(6));
  fireEvent.click(within(stageCard(5)).getByRole('button', { name: /Remove action 6|删除操作 6/u }));
  fireEvent.click(within(stageCard(4)).getByRole('button', { name: /Remove action 5|删除操作 5/u }));
  await waitFor(() => expect(latestValue(onChange)[0]?.update).toHaveLength(4));

  await selectOption(within(stageCard(0)).getByTestId('request-transform-target'), /^(Header|请求头)$/u);
  fireEvent.change(within(stageCard(0)).getByRole('textbox', { name: /Header name|请求头名称/u }), {
    target: { value: 'X-Test' },
  });
  await waitFor(() =>
    expect(latestValue(onChange)[0]?.update[0]).toEqual({
      $set: {
        'request.headers': {
          $setField: { field: 'x-test', input: '$request.headers', value: { $literal: '$seed' } },
        },
      },
    }),
  );
  await selectOption(within(stageCard(0)).getByTestId('request-transform-target'), /^(Body|请求体)$/u);
  fireEvent.change(within(stageCard(0)).getByRole('textbox', { name: /Body path|请求体路径/u }), {
    target: { value: 'value' },
  });

  fireEvent.click(within(stageCard(2)).getByRole('button', { name: /Move action 3 up|上移操作 3/u }));
  await waitFor(() =>
    expect(latestValue(onChange)[0]?.update.slice(0, 2)).toEqual([
      { $set: { 'request.body.value': { $literal: '$seed' } } },
      { $unset: 'request.body.value' },
    ]),
  );
  expect(latestValue(onChange)[0]?.update).toHaveLength(4);
  fireEvent.click(within(stageCard(1)).getByRole('button', { name: /Move action 2 down|下移操作 2/u }));

  await selectOption(within(stageCard(0)).getByTestId('request-transform-value-mode'), /^(Computed|计算)$/u);
  await waitFor(() =>
    expect(latestValue(onChange)[0]?.update[0]).toEqual({ $set: { 'request.body.value': '$request.body.value' } }),
  );
  await selectOption(within(stageCard(0)).getByTestId('transform-set-expression-kind'), /^(Function|函数)$/u);
  await selectOption(within(stageCard(0)).getByTestId('transform-set-expression-fn'), /^(CONCAT|Concatenate|拼接)$/u);
  await selectOption(
    within(stageCard(0)).getByTestId('transform-set-expression-arg0-field-kind'),
    /Current body field|当前请求体字段/u,
  );
  fireEvent.change(within(stageCard(0)).getByTestId('transform-set-expression-arg0-field-suffix'), {
    target: { value: 'name' },
  });
  await selectOption(within(stageCard(0)).getByTestId('transform-set-expression-arg1-kind'), /^(Function|函数)$/u);
  await selectOption(
    within(stageCard(0)).getByTestId('transform-set-expression-arg1-fn'),
    /^(UPPER|Uppercase|转大写)$/u,
  );
  await selectOption(
    within(stageCard(0)).getByTestId('transform-set-expression-arg1-arg0-field-kind'),
    /Original body field|原始请求体字段/u,
  );
  fireEvent.change(within(stageCard(0)).getByTestId('transform-set-expression-arg1-arg0-field-suffix'), {
    target: { value: 'suffix' },
  });
  await waitFor(() =>
    expect(latestValue(onChange)[0]?.update[0]).toEqual({
      $set: {
        'request.body.value': { $concat: ['$request.body.name', { $toUpper: ['$original.body.suffix'] }] },
      },
    }),
  );

  await selectOption(within(stageCard(0)).getByTestId('request-transform-value-mode'), /^(Static|静态)$/u);
  const staticEditor = within(stageCard(0)).getByRole('textbox', { name: /Static value|静态值/u });
  fireEvent.change(staticEditor, { target: { value: '"$literal"' } });
  await waitFor(() =>
    expect(latestValue(onChange)[0]?.update[0]).toEqual({
      $set: { 'request.body.value': { $literal: '$literal' } },
    }),
  );

  const canonical = JSON.stringify(latestValue(onChange));
  const changeCount = onChange.mock.calls.length;
  fireEvent.click(screen.getByRole('tab', { name: /JSON/u }));
  const jsonEditor = await screen.findByRole('textbox', { name: /request transforms json/i });
  expect(JSON.stringify(JSON.parse((jsonEditor as HTMLTextAreaElement).value))).toBe(canonical);
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole('tab', { name: /Visual|可视化/u }));
  await screen.findByTestId('request-transform-rule-0');
  expect(JSON.stringify(latestValue(onChange))).toBe(canonical);
  expect(onChange).toHaveBeenCalledTimes(changeCount);
});
