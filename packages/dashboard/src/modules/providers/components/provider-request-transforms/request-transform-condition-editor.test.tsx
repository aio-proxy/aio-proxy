import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

import { RequestTransformConditionEditor } from './request-transform-condition-editor';

type Condition = NonNullable<ProviderRequestTransformRule['when']>;

interface ConditionEditorHarnessProps {
  readonly initialValue: Condition;
  readonly onChange: (value: Condition) => void;
}

const ConditionEditorHarness: React.FC<ConditionEditorHarnessProps> = ({ initialValue, onChange }) => {
  const [value, setValue] = useState(initialValue);
  return (
    <RequestTransformConditionEditor
      value={value}
      onChange={(nextValue) => {
        setValue(nextValue);
        onChange(nextValue);
      }}
    />
  );
};

const selectOption = async (trigger: HTMLElement, name: string | RegExp) => {
  fireEvent.click(trigger);
  const option = await screen.findByRole('option', { name });
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
};

const latestValue = (onChange: ReturnType<typeof rs.fn>) => onChange.mock.calls.at(-1)?.[0] as Condition;

const andClauses = (condition: Condition): unknown[] => {
  const clauses = (condition as Record<string, unknown>)['$and'];
  return Array.isArray(clauses) ? clauses : [];
};

test('decodes and edits Pattern, Header, Regex, and arithmetic conditions without changing their AST forms', async () => {
  const initialValue = {
    $and: [
      { 'request.model': { $regex: '^(?:gpt-.*)$' } },
      {
        $expr: {
          $eq: [{ $getField: { field: 'x-route', input: '$request.headers' } }, 'blue'],
        },
      },
      {
        $expr: {
          $regexMatch: {
            input: { $getField: { field: 'x-origin', input: '$original.headers' } },
            regex: '^team-',
            options: '',
          },
        },
      },
      {
        $expr: {
          $gt: [{ $add: ['$request.body.input', 1] }, '$original.body.limit'],
        },
      },
    ],
  } satisfies Condition;
  const onChange = rs.fn();

  render(<ConditionEditorHarness initialValue={initialValue} onChange={onChange} />);

  const rules = screen.getAllByTestId('rule');
  expect(within(rules[0]!).getByTestId('fields-kind')).toHaveTextContent(/Current model|当前模型/u);
  expect(within(rules[0]!).getByTestId('operators')).toHaveTextContent(/Matches pattern|匹配模式/u);
  expect(within(rules[0]!).getByTestId('value-editor')).toHaveValue('gpt-*');

  expect(within(rules[1]!).getByTestId('fields-kind')).toHaveTextContent(/Current header|当前请求头/u);
  expect(within(rules[1]!).getByTestId('fields-suffix')).toHaveValue('x-route');
  expect(within(rules[1]!).getByTestId('operators')).toHaveTextContent(/Equals|等于/u);
  expect(within(rules[1]!).getByTestId('value-editor')).toHaveValue('blue');

  expect(within(rules[2]!).getByTestId('fields-kind')).toHaveTextContent(/Original header|原始请求头/u);
  expect(within(rules[2]!).getByTestId('fields-suffix')).toHaveValue('x-origin');
  expect(within(rules[2]!).getByTestId('operators')).toHaveTextContent(/Regex|正则/u);
  expect(within(rules[2]!).getByTestId('value-editor-regex')).toHaveValue('^team-');
  expect(within(rules[2]!).getByTestId('value-editor-options')).toHaveValue('');

  expect(within(rules[3]!).getByTestId('expr-lhs-fn-selector')).toHaveTextContent(/Add|加法/u);
  expect(within(rules[3]!).getByTestId('fields-kind')).toHaveTextContent(/Current body field|当前请求体字段/u);
  expect(within(rules[3]!).getByTestId('fields-suffix')).toHaveValue('input');
  expect(within(rules[3]!).getByTestId('expr-lhs-arg-editor-1-kind')).toHaveTextContent(/Value|值/u);
  expect(within(rules[3]!).getByTestId('expr-lhs-arg-editor-1-value')).toHaveValue('1');
  expect(within(rules[3]!).getByTestId('expr-rhs-editor-field-kind')).toHaveTextContent(
    /Original body field|原始请求体字段/u,
  );
  expect(within(rules[3]!).getByTestId('expr-rhs-editor-field-suffix')).toHaveValue('limit');

  fireEvent.click(within(rules[1]!).getByTestId('operators'));
  expect(await screen.findByRole('option', { name: /^(Matches pattern|匹配模式)$/u })).toBeTruthy();
  expect(screen.queryByRole('option', { name: /^(Greater than|大于)$/u })).toBeNull();
  const equalsOption = screen.getByRole('option', { name: /^(Equals|等于)$/u });
  fireEvent.pointerDown(equalsOption, { pointerType: 'mouse' });
  fireEvent.click(equalsOption);

  fireEvent.change(within(screen.getAllByTestId('rule')[0]!).getByTestId('value-editor'), {
    target: { value: 'gpt.+*' },
  });
  await waitFor(() =>
    expect(andClauses(latestValue(onChange))[0]).toEqual({
      'request.model': { $regex: '^(?:gpt\\.\\+.*)$' },
    }),
  );

  const headerRule = screen.getAllByTestId('rule')[1]!;
  fireEvent.change(within(headerRule).getByTestId('fields-suffix'), { target: { value: 'X-NEW' } });
  await waitFor(() =>
    expect(andClauses(latestValue(onChange))[1]).toEqual({
      $expr: {
        $eq: [{ $getField: { field: 'x-new', input: '$request.headers' } }, 'blue'],
      },
    }),
  );
  fireEvent.change(within(screen.getAllByTestId('rule')[1]!).getByTestId('value-editor'), {
    target: { value: 'green' },
  });
  await waitFor(() =>
    expect(andClauses(latestValue(onChange))[1]).toEqual({
      $expr: {
        $eq: [{ $getField: { field: 'x-new', input: '$request.headers' } }, 'green'],
      },
    }),
  );

  fireEvent.change(within(screen.getAllByTestId('rule')[2]!).getByTestId('value-editor-regex'), {
    target: { value: '^platform-' },
  });
  await waitFor(() =>
    expect(andClauses(latestValue(onChange))[2]).toEqual({
      $expr: {
        $regexMatch: {
          input: { $getField: { field: 'x-origin', input: '$original.headers' } },
          regex: '^platform-',
          options: '',
        },
      },
    }),
  );

  const expressionRule = screen.getAllByTestId('rule')[3]!;
  fireEvent.change(within(expressionRule).getByTestId('fields-suffix'), { target: { value: 'input_tokens' } });
  await waitFor(() =>
    expect(andClauses(latestValue(onChange))[3]).toEqual({
      $expr: {
        $gt: [{ $add: ['$request.body.input_tokens', 1] }, '$original.body.limit'],
      },
    }),
  );
  fireEvent.change(within(screen.getAllByTestId('rule')[3]!).getByTestId('expr-lhs-arg-editor-1-value'), {
    target: { value: '2' },
  });
  await waitFor(() =>
    expect(andClauses(latestValue(onChange))[3]).toEqual({
      $expr: {
        $gt: [{ $add: ['$request.body.input_tokens', 2] }, '$original.body.limit'],
      },
    }),
  );
});

test('builds a numeric comparison for an arbitrary current body path', async () => {
  const onChange = rs.fn();
  render(<ConditionEditorHarness initialValue={{}} onChange={onChange} />);

  fireEvent.click(screen.getByRole('button', { name: /Add condition|添加条件/u }));
  const rule = await screen.findByTestId('rule');
  onChange.mockClear();
  await selectOption(within(rule).getByTestId('fields-kind'), /Current body field|当前请求体字段/u);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(await screen.findByTestId('fields-suffix'), {
    target: { value: 'max_output_tokens' },
  });
  await selectOption(within(screen.getByTestId('rule')).getByTestId('operators'), /^(Greater than|大于)$/u);
  fireEvent.change(within(screen.getByTestId('rule')).getByTestId('value-editor'), { target: { value: '8192' } });

  await waitFor(() => expect(latestValue(onChange)).toEqual({ 'request.body.max_output_tokens': { $gt: 8192 } }));
});
