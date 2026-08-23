/* oxlint-disable max-lines */

import { m } from '@aio-proxy/i18n';
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

const requestHeader = (name: string) => ({ $getField: { field: name, input: '$request.headers' } });

// Field and expression-kind labels are read from the messages instead of hardcoded, so a copy change
// cannot turn a decoding assertion red; what these lines protect is which field a clause decodes to.
const currentBodyField = m['dashboard.providers.transforms.condition.field.current_body']();
const originalBodyField = m['dashboard.providers.transforms.condition.field.original_body']();
const currentHeaderField = m['dashboard.providers.transforms.condition.field.current_header']();
const originalHeaderField = m['dashboard.providers.transforms.condition.field.original_header']();
const fixedValueKind = m['dashboard.providers.transforms.condition.expression_kind.value']();

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

  expect(within(rules[1]!).getByTestId('fields-kind')).toHaveTextContent(currentHeaderField);
  expect(within(rules[1]!).getByTestId('fields-suffix')).toHaveValue('x-route');
  expect(within(rules[1]!).getByTestId('operators')).toHaveTextContent(/Equals|等于/u);
  expect(within(rules[1]!).getByTestId('value-editor')).toHaveValue('blue');

  expect(within(rules[2]!).getByTestId('fields-kind')).toHaveTextContent(originalHeaderField);
  expect(within(rules[2]!).getByTestId('fields-suffix')).toHaveValue('x-origin');
  expect(within(rules[2]!).getByTestId('operators')).toHaveTextContent(/Regex|正则/u);
  expect(within(rules[2]!).getByTestId('value-editor-regex')).toHaveValue('^team-');
  expect(within(rules[2]!).getByTestId('value-editor-options')).toHaveValue('');

  expect(within(rules[3]!).getByTestId('expr-lhs-fn-selector')).toHaveTextContent('+');
  expect(within(rules[3]!).getByTestId('fields-kind')).toHaveTextContent(currentBodyField);
  expect(within(rules[3]!).getByTestId('fields-suffix')).toHaveValue('input');
  expect(within(rules[3]!).getByTestId('expr-lhs-arg-editor-1-kind')).toHaveTextContent(fixedValueKind);
  expect(within(rules[3]!).getByTestId('expr-lhs-arg-editor-1-value')).toHaveValue('1');
  expect(within(rules[3]!).getByTestId('expr-rhs-editor-field-kind')).toHaveTextContent(originalBodyField);
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
  await selectOption(within(rule).getByTestId('fields-kind'), currentBodyField);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(await screen.findByTestId('fields-suffix'), {
    target: { value: 'max_output_tokens' },
  });
  await selectOption(within(screen.getByTestId('rule')).getByTestId('operators'), /^(Greater than|大于)$/u);
  fireEvent.change(within(screen.getByTestId('rule')).getByTestId('value-editor'), { target: { value: '8192' } });

  await waitFor(() => expect(latestValue(onChange)).toEqual({ 'request.body.max_output_tokens': { $gt: 8192 } }));
});

test('shows a short remove label on a condition row while keeping the full title', () => {
  render(<ConditionEditorHarness initialValue={{ 'request.model': 'gpt-4' }} onChange={rs.fn()} />);

  const remove = within(screen.getByTestId('rule')).getByRole('button');
  // Exact text, not `toHaveTextContent`: the long title is a superstring of the short label.
  expect(remove.textContent).toBe(m['dashboard.providers.transforms.condition.action.remove']());
  expect(remove).toHaveAttribute('title', m['dashboard.providers.transforms.condition.action.remove_condition']());
});

test('leaves a condition row with remove as its only action button', () => {
  render(
    <ConditionEditorHarness
      initialValue={{ $and: [{ 'request.model': 'gpt-4' }, { 'request.url': 'a' }] }}
      onChange={rs.fn()}
    />,
  );

  for (const rule of screen.getAllByTestId('rule')) {
    const actions = within(rule).getAllByRole('button');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toHaveAccessibleName(m['dashboard.providers.transforms.condition.action.remove_condition']());
  }
});

test('preserves the active value editor while accepting controlled character-by-character updates', async () => {
  const onChange = rs.fn();
  render(
    <ConditionEditorHarness initialValue={{ $expr: { $eq: [requestHeader('x-route'), ''] } }} onChange={onChange} />,
  );

  const input = screen.getByTestId('value-editor');
  input.focus();
  let typed = '';
  for (const character of 'blue') {
    typed += character;
    fireEvent.change(input, { target: { value: typed } });
    await waitFor(() => expect(screen.getByTestId('value-editor')).toBe(input));
    expect(document.activeElement).toBe(input);
  }

  expect(latestValue(onChange)).toEqual({ $expr: { $eq: [requestHeader('x-route'), 'blue'] } });
});

test('replaces the local query when the controlled condition changes externally', async () => {
  const onChange = rs.fn();
  const { rerender } = render(
    <RequestTransformConditionEditor
      value={{ $expr: { $eq: [requestHeader('x-route'), 'blue'] } }}
      onChange={onChange}
    />,
  );

  rerender(
    <RequestTransformConditionEditor
      value={{ $expr: { $eq: [requestHeader('x-route'), 'green'] } }}
      onChange={onChange}
    />,
  );

  await waitFor(() => expect(screen.getByTestId('value-editor')).toHaveValue('green'));
  expect(onChange).not.toHaveBeenCalled();
});

test('keeps numeric-looking header equality values as strings', async () => {
  const onChange = rs.fn();
  render(
    <ConditionEditorHarness initialValue={{ $expr: { $eq: [requestHeader('x-route'), ''] } }} onChange={onChange} />,
  );

  fireEvent.change(screen.getByTestId('value-editor'), { target: { value: '001' } });

  await waitFor(() => expect(latestValue(onChange)).toEqual({ $expr: { $eq: [requestHeader('x-route'), '001'] } }));
});

test('keeps numeric-looking provider, model, URL, Pattern, and Regex values as strings', async () => {
  const onChange = rs.fn();
  render(
    <ConditionEditorHarness
      initialValue={{
        $and: [
          { 'provider.id': '' },
          { 'request.model': '' },
          { 'request.url': '' },
          { 'request.requestedModel': { $regex: '^(?:)$' } },
          { 'request.method': { $regex: '', $options: '' } },
        ],
      }}
      onChange={onChange}
    />,
  );

  const rules = screen.getAllByTestId('rule');
  fireEvent.change(within(rules[0]!).getByTestId('value-editor'), { target: { value: '001' } });
  fireEvent.change(within(rules[1]!).getByTestId('value-editor'), { target: { value: '001' } });
  fireEvent.change(within(rules[2]!).getByTestId('value-editor'), { target: { value: '001' } });
  fireEvent.change(within(rules[3]!).getByTestId('value-editor'), { target: { value: '001' } });
  fireEvent.change(within(rules[4]!).getByTestId('value-editor-regex'), { target: { value: '001' } });

  await waitFor(() =>
    expect(latestValue(onChange)).toEqual({
      $and: [
        { 'provider.id': '001' },
        { 'request.model': '001' },
        { 'request.url': '001' },
        { 'request.requestedModel': { $regex: '^(?:001)$' } },
        { 'request.method': { $regex: '001', $options: '' } },
      ],
    }),
  );
});

test('keeps body equality strings unchanged after an unrelated rule edit', async () => {
  const onChange = rs.fn();
  render(
    <ConditionEditorHarness
      initialValue={{ $and: [{ 'request.body.code': '001' }, { 'request.model': 'gpt-4' }] }}
      onChange={onChange}
    />,
  );

  const modelRule = screen.getAllByTestId('rule')[1]!;
  fireEvent.change(within(modelRule).getByTestId('value-editor'), { target: { value: 'gpt-5' } });

  await waitFor(() =>
    expect(latestValue(onChange)).toEqual({
      $and: [{ 'request.body.code': '001' }, { 'request.model': 'gpt-5' }],
    }),
  );
});

test('keeps string literals inside body expressions unchanged after an unrelated rule edit', async () => {
  const onChange = rs.fn();
  render(
    <ConditionEditorHarness
      initialValue={{
        $and: [
          {
            $expr: {
              $eq: [{ $concat: ['$request.body.code', '001'] }, 'prefix-001'],
            },
          },
          { 'request.model': 'gpt-4' },
        ],
      }}
      onChange={onChange}
    />,
  );

  const modelRule = screen.getAllByTestId('rule')[1]!;
  fireEvent.change(within(modelRule).getByTestId('value-editor'), { target: { value: 'gpt-5' } });

  await waitFor(() =>
    expect(latestValue(onChange)).toEqual({
      $and: [
        {
          $expr: {
            $eq: [{ $concat: ['$request.body.code', '001'] }, 'prefix-001'],
          },
        },
        { 'request.model': 'gpt-5' },
      ],
    }),
  );
});

test('resets incompatible values when switching between Pattern, Regex, and Equals', async () => {
  const onChange = rs.fn();
  render(
    <ConditionEditorHarness
      initialValue={{
        $expr: {
          $regexMatch: {
            input: requestHeader('x-route'),
            regex: '^(?:team-.*)$',
          },
        },
      }}
      onChange={onChange}
    />,
  );

  await selectOption(screen.getByTestId('operators'), /^(Regex|正则)$/u);
  await waitFor(() =>
    expect(latestValue(onChange)).toEqual({
      $expr: {
        $regexMatch: {
          input: requestHeader('x-route'),
          regex: '',
          options: '',
        },
      },
    }),
  );
  expect(screen.getByTestId('value-editor-regex')).toHaveValue('');
  expect(screen.getByTestId('value-editor-options')).toHaveValue('');

  fireEvent.change(screen.getByTestId('value-editor-regex'), { target: { value: '^team-' } });
  await selectOption(screen.getByTestId('operators'), /^(Matches pattern|匹配模式)$/u);
  await waitFor(() =>
    expect(latestValue(onChange)).toEqual({
      $expr: {
        $regexMatch: {
          input: requestHeader('x-route'),
          regex: '^(?:)$',
        },
      },
    }),
  );
  expect(screen.getByTestId('value-editor')).toHaveValue('');

  await selectOption(screen.getByTestId('operators'), /^(Regex|正则)$/u);
  fireEvent.change(screen.getByTestId('value-editor-regex'), { target: { value: '^team-' } });
  await selectOption(screen.getByTestId('operators'), /^(Equals|等于)$/u);
  await waitFor(() => expect(latestValue(onChange)).toEqual({ $expr: { $eq: [requestHeader('x-route'), ''] } }));
  expect(screen.getByTestId('value-editor')).toHaveValue('');
});

test('serializes Header Pattern, existence, and list operators to canonical Mongo conditions', async () => {
  const initialValue = {
    $and: [
      {
        $expr: {
          $regexMatch: {
            input: requestHeader('x-team'),
            regex: '^(?:team-.*)$',
          },
        },
      },
      { $expr: { $ne: [{ $ifNull: [requestHeader('x-present'), null] }, null] } },
      { $expr: { $eq: [{ $ifNull: [requestHeader('x-missing'), null] }, null] } },
      { 'request.model': { $in: ['gpt-4', 'claude-3'] } },
      { 'request.url': { $nin: ['https://a.example', 'https://b.example'] } },
    ],
  } satisfies Condition;
  const onChange = rs.fn();
  render(<ConditionEditorHarness initialValue={initialValue} onChange={onChange} />);

  const rules = screen.getAllByTestId('rule');
  expect(within(rules[0]!).getByTestId('operators')).toHaveTextContent(/Matches pattern|匹配模式/u);
  expect(within(rules[1]!).getByTestId('operators')).toHaveTextContent(/Exists|存在/u);
  expect(within(rules[2]!).getByTestId('operators')).toHaveTextContent(/Does not exist|不存在/u);
  expect(within(rules[3]!).getByTestId('operators')).toHaveTextContent(/In|包含/u);
  expect(within(rules[4]!).getByTestId('operators')).toHaveTextContent(/Not in|不包含/u);

  fireEvent.change(within(rules[3]!).getByTestId('value-editor'), { target: { value: 'gpt-5, claude-4' } });
  await waitFor(() =>
    expect(andClauses(latestValue(onChange))[3]).toEqual({
      'request.model': { $in: ['gpt-5', 'claude-4'] },
    }),
  );

  fireEvent.change(within(screen.getAllByTestId('rule')[4]!).getByTestId('value-editor'), {
    target: { value: 'https://c.example, https://d.example' },
  });

  await waitFor(() =>
    expect(latestValue(onChange)).toEqual({
      $and: [
        {
          $expr: {
            $regexMatch: {
              input: requestHeader('x-team'),
              regex: '^(?:team-.*)$',
            },
          },
        },
        { $expr: { $ne: [{ $ifNull: [requestHeader('x-present'), null] }, null] } },
        { $expr: { $eq: [{ $ifNull: [requestHeader('x-missing'), null] }, null] } },
        { 'request.model': { $in: ['gpt-5', 'claude-4'] } },
        { 'request.url': { $nin: ['https://c.example', 'https://d.example'] } },
      ],
    }),
  );
});
