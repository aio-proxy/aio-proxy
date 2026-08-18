/* oxlint-disable max-lines, max-lines-per-function */

import { ProviderRequestTransformRulesSchema, type ProviderRequestTransformRule } from '@aio-proxy/types';
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
        onChange(nextValue);
        if (ProviderRequestTransformRulesSchema.safeParse(nextValue).success) setValue(nextValue);
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

test('labels unnamed rules by index and renders Add rule after the rule list', () => {
  render(
    <RequestTransformsHarness
      initialValue={[{ update: [{ $unset: 'request.body.value' }] }]}
      onChange={rs.fn()}
      onValidityChange={rs.fn()}
    />,
  );

  const rule = ruleCard(0);
  expect(within(rule).getByText(/^Rule 1$|^规则 1$/u)).toBeInTheDocument();
  const addRule = screen.getByRole('button', { name: /Add rule|添加规则/u });
  expect(rule.compareDocumentPosition(addRule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('directly adds one Set action and stores an explicitly selected null', async () => {
  const onChange = rs.fn();
  render(
    <RequestTransformsHarness
      initialValue={[{ update: [{ $set: { 'request.body.value': 'seed' } }] }]}
      onChange={onChange}
      onValidityChange={rs.fn()}
    />,
  );

  fireEvent.click(within(ruleCard(0)).getByRole('button', { name: /Add action|添加操作/u }));
  await waitFor(() => expect(latestValue(onChange)[0]?.update).toHaveLength(2));
  expect(latestValue(onChange)[0]?.update[1]).toEqual({ $set: { 'request.body.value': null } });

  await selectOption(within(stageCard(0)).getByTestId('request-transform-static-type'), /^(Null|空值)$/u);
  await waitFor(() => expect(latestValue(onChange)[0]?.update[0]).toEqual({ $set: { 'request.body.value': null } }));
  expect(within(stageCard(0)).queryByRole('textbox', { name: /Value to set|设置值/u })).toBeNull();
});

test('shows and clears an accessible error for an invalid number literal', async () => {
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  render(
    <RequestTransformsHarness
      initialValue={[{ update: [{ $set: { 'request.body.value': 'seed' } }] }]}
      onChange={onChange}
      onValidityChange={onValidityChange}
    />,
  );

  await selectOption(within(stageCard(0)).getByTestId('request-transform-static-type'), /^(Number|数字)$/u);
  const numberInput = within(stageCard(0)).getByRole('spinbutton', { name: /Value to set|设置值/u });
  fireEvent.change(numberInput, { target: { value: '' } });

  const error = within(stageCard(0)).getByRole('alert');
  expect(error).toHaveTextContent(/valid number|有效数字/u);
  expect(numberInput).toHaveAttribute('aria-invalid', 'true');
  expect(numberInput).toHaveAttribute('aria-describedby', error.id);
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));

  fireEvent.change(numberInput, { target: { value: '12.5' } });
  await waitFor(() => expect(latestValue(onChange)[0]?.update[0]).toEqual({ $set: { 'request.body.value': 12.5 } }));
  expect(numberInput).toHaveAttribute('aria-invalid', 'false');
  expect(numberInput).not.toHaveAttribute('aria-describedby');
  expect(within(stageCard(0)).queryByRole('alert')).toBeNull();
});

test('offers booleans as a true/false select rather than a checkbox', async () => {
  const onChange = rs.fn();
  render(
    <RequestTransformsHarness
      initialValue={[{ update: [{ $set: { 'request.body.value': 'seed' } }] }]}
      onChange={onChange}
      onValidityChange={rs.fn()}
    />,
  );

  // By accessible name, not testid: the type select's own label pairing has to keep working.
  const typeSelect = within(stageCard(0)).getByRole('combobox', { name: /^(Value type|值类型)$/u });
  await selectOption(typeSelect, /^(Boolean|布尔值)$/u);
  const booleanControl = within(stageCard(0)).getByRole('combobox', { name: /Value to set|设置值/u });
  expect(booleanControl).toHaveAttribute('data-testid', 'request-transform-static-boolean');
  expect(within(stageCard(0)).queryByRole('checkbox')).toBeNull();

  await selectOption(booleanControl, /^true$/u);
  // `staticExpression` only wraps arrays, objects and `$`-prefixed strings, so a boolean stays bare.
  await waitFor(() => expect(latestValue(onChange)[0]?.update[0]).toEqual({ $set: { 'request.body.value': true } }));
});

test('gates applying JSON on a draft that parses to the selected type', async () => {
  const onChange = rs.fn();
  render(
    <RequestTransformsHarness
      initialValue={[{ update: [{ $set: { 'request.body.value': { $literal: [1, 2] } } }] }]}
      onChange={onChange}
      onValidityChange={rs.fn()}
    />,
  );

  // The name anchors the label and the compact value, so losing either half fails here.
  const arrayControl = within(stageCard(0)).getByRole('button', { name: /(Value to set|设置值)\s*\[1,2\]/u });
  fireEvent.click(arrayControl);

  const drawer = await screen.findByTestId('request-transform-json-drawer');
  const jsonDraft = within(drawer).getByTestId('request-transform-json-draft');
  const apply = within(drawer).getByTestId('request-transform-json-apply');
  // Exact equality: the drawer seeds the indented form while the button shows the compact one.
  expect(jsonDraft).toHaveValue('[\n  1,\n  2\n]');
  fireEvent.change(jsonDraft, { target: { value: '{}' } });

  expect(apply).toBeDisabled();
  const error = within(drawer).getByRole('alert');
  expect(error).toHaveTextContent(/valid JSON array|有效的 JSON 数组/u);
  // The field is named for what it holds, not for the drawer title, and points at its own error.
  expect(jsonDraft).toHaveAccessibleName(/Value to set|设置值/u);
  expect(jsonDraft).toHaveAttribute('aria-describedby', error.id);

  fireEvent.change(jsonDraft, { target: { value: '[1]' } });
  expect(apply).not.toBeDisabled();
  fireEvent.click(apply);
  await waitFor(() =>
    expect(latestValue(onChange)[0]?.update[0]).toEqual({ $set: { 'request.body.value': { $literal: [1] } } }),
  );
  expect(screen.queryByTestId('request-transform-json-drawer')).toBeNull();
});

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
  expect(within(stages[0]!).getByTestId('request-transform-value-mode')).toHaveTextContent(/Fixed value|固定值/u);
  expect(within(stages[0]!).getByRole('textbox', { name: /Value to set|设置值/u })).toHaveValue('$seed');
  expect(within(stages[1]!).getByTestId('request-transform-target')).toHaveTextContent(/Header|请求头/u);
  expect(within(stages[1]!).getByRole('textbox', { name: /Header name|请求头名称/u })).toHaveValue('x-route');
  expect(within(stages[1]!).getByTestId('request-transform-value-mode')).toHaveTextContent(/Computed|计算/u);
  expect(within(stages[1]!).getByTestId('transform-set-expression-fn')).toHaveTextContent(/CONCAT|Concatenate|拼接/u);
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

  fireEvent.click(within(ruleCard(0)).getByRole('button', { name: /Add action|添加操作/u }));
  fireEvent.click(within(ruleCard(0)).getByRole('button', { name: /Add action|添加操作/u }));
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

  await selectOption(within(stageCard(0)).getByTestId('request-transform-value-mode'), /^(Fixed value|固定值)$/u);
  await selectOption(within(stageCard(0)).getByTestId('request-transform-static-type'), /^(Text|文本)$/u);
  const staticEditor = within(stageCard(0)).getByRole('textbox', { name: /Value to set|设置值/u });
  fireEvent.change(staticEditor, { target: { value: '$literal' } });
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
}, 10_000);

test('retains unsafe stage control drafts until shared rule validation accepts them', async () => {
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  render(
    <RequestTransformsHarness initialValue={initialValue} onChange={onChange} onValidityChange={onValidityChange} />,
  );

  const bodyPath = within(stageCard(0)).getByRole('textbox', { name: /Body path|请求体路径/u });
  fireEvent.change(bodyPath, { target: { value: '__proto__' } });

  expect(bodyPath).toHaveValue('__proto__');
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
  expect(onChange).not.toHaveBeenCalled();

  await selectOption(within(stageCard(0)).getByTestId('request-transform-target'), /^(Header|请求头)$/u);
  const headerName = within(stageCard(0)).getByRole('textbox', { name: /Header name|请求头名称/u });
  expect(headerName).toHaveValue('__proto__');
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.change(headerName, { target: { value: 'X-Good' } });
  await waitFor(() =>
    expect(latestValue(onChange)[0]?.update[0]).toEqual({
      $set: {
        'request.headers': {
          $setField: { field: 'x-good', input: '$request.headers', value: { $literal: '$seed' } },
        },
      },
    }),
  );
  expect(headerName).toHaveValue('x-good');
  expect(onValidityChange).toHaveBeenLastCalledWith(true);
});

test('seeds a refused computed stage with an editable body field', async () => {
  const onChange = rs.fn();
  render(<RequestTransformsHarness initialValue={initialValue} onChange={onChange} onValidityChange={rs.fn()} />);

  // A refused commit never round trips through the codec, so the seeded default is observable as authored.
  fireEvent.change(within(stageCard(0)).getByRole('textbox', { name: /Body path|请求体路径/u }), {
    target: { value: '__proto__' },
  });
  await selectOption(within(stageCard(0)).getByTestId('request-transform-value-mode'), /^(Computed|计算)$/u);

  expect(within(stageCard(0)).getByTestId('transform-set-expression-field-suffix')).toHaveValue('value');
  expect(within(stageCard(0)).getByTestId('transform-set-expression-field-kind')).toHaveTextContent(
    /Current body field|当前请求体字段/u,
  );
  expect(onChange).not.toHaveBeenCalled();
});

test('names every nested expression argument by its argument path', () => {
  const nestedValue = [
    {
      update: [
        {
          $set: {
            'request.body.value': { $concat: ['$request.body.a', { $min: ['$request.body.b', 1] }] },
          },
        },
      ],
    },
  ] satisfies readonly ProviderRequestTransformRule[];
  render(<RequestTransformsHarness initialValue={nestedValue} onChange={rs.fn()} onValidityChange={rs.fn()} />);

  const outer = screen.getByRole('combobox', { name: /^(Argument 1 → Field|参数 1 → 字段)$/u });
  const inner = screen.getByRole('combobox', { name: /^(Argument 2 → Argument 1 → Field|参数 2 → 参数 1 → 字段)$/u });
  expect(outer).toHaveAttribute('data-testid', 'transform-set-expression-arg0-field-kind');
  expect(inner).toHaveAttribute('data-testid', 'transform-set-expression-arg1-arg0-field-kind');
});

test('contains a discarded JSON draft inside the drawer instead of the form', async () => {
  const objectValue = [
    { update: [{ $set: { 'request.body.value': { $literal: { seed: true } } } }] },
  ] satisfies readonly ProviderRequestTransformRule[];
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  render(
    <RequestTransformsHarness initialValue={objectValue} onChange={onChange} onValidityChange={onValidityChange} />,
  );

  const objectControl = within(stageCard(0)).getByRole('button', { name: /Value to set|设置值/u });
  fireEvent.click(objectControl);
  const drawer = await screen.findByTestId('request-transform-json-drawer');
  fireEvent.change(within(drawer).getByTestId('request-transform-json-draft'), { target: { value: '{' } });

  expect(within(drawer).getByTestId('request-transform-json-apply')).toBeDisabled();
  expect(within(drawer).getByRole('alert')).toHaveTextContent(/valid JSON object|有效的 JSON 对象/u);

  fireEvent.click(within(drawer).getByRole('button', { name: /Cancel|取消/u }));

  // The unparseable text never left the drawer, so the form still holds the committed object.
  expect(onChange).not.toHaveBeenCalled();
  expect(onValidityChange).not.toHaveBeenCalledWith(false);
  expect(screen.getByRole('tab', { name: /JSON/u })).not.toHaveAttribute('aria-disabled', 'true');

  fireEvent.click(within(stageCard(0)).getByRole('button', { name: /Value to set|设置值/u }));
  const reopened = await screen.findByTestId('request-transform-json-drawer');
  expect(
    JSON.parse((within(reopened).getByTestId('request-transform-json-draft') as HTMLTextAreaElement).value),
  ).toEqual({ seed: true });
});

test('retains incomplete computed fields and blocks switching modes until the expression is valid', async () => {
  const computedValue = [
    {
      update: [{ $set: { 'request.body.value': { $concat: ['$request.body.route', '-suffix'] } } }],
    },
  ] satisfies readonly ProviderRequestTransformRule[];
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  render(
    <RequestTransformsHarness initialValue={computedValue} onChange={onChange} onValidityChange={onValidityChange} />,
  );

  await selectOption(within(stageCard(0)).getByTestId('transform-set-expression-kind'), /^(Field|字段)$/u);
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  onChange.mockClear();
  onValidityChange.mockClear();

  await selectOption(
    within(stageCard(0)).getByTestId('transform-set-expression-field-kind'),
    /Current body field|当前请求体字段/u,
  );
  const suffix = within(stageCard(0)).getByTestId('transform-set-expression-field-suffix');
  expect(suffix).toHaveValue('');
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
  expect(onChange).not.toHaveBeenCalled();
  const jsonTab = screen.getByRole('tab', { name: /JSON/u });
  expect(jsonTab).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(jsonTab);
  expect(suffix).toHaveValue('');

  fireEvent.change(suffix, { target: { value: 'payload' } });
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith([
      { update: [{ $set: { 'request.body.value': '$request.body.payload' } }] },
    ]),
  );
  expect(onValidityChange).toHaveBeenLastCalledWith(true);
  expect(jsonTab).not.toHaveAttribute('aria-disabled', 'true');
});
