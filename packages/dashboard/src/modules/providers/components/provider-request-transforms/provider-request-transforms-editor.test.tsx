import { m } from '@aio-proxy/i18n';
import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { beforeEach, expect, rs, test } from '@rstest/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';

import { JsonEditor, type JsonEditorValueAcknowledgement } from '@/components/json-editor/json-editor';
import type { JsonValue } from '@/components/json-editor/json-editor-state';

import { ProviderRequestTransformsEditor } from './provider-request-transforms-editor';

const validationMocks = rs.hoisted(() => ({
  requests: [] as Array<{
    readonly resolve: (markers: readonly { readonly severity: 'error' | 'warning' }[]) => void;
  }>,
}));

rs.mock('@/components/json-editor/json-schema-registry', () => ({
  registerJsonSchema: () => () => undefined,
}));

rs.mock('@/components/json-editor/json-language-service', () => ({
  createJsonLanguageExtensions: (
    _uri: string,
    _schema: unknown,
    onValidation: (draft: string, markers: readonly { readonly severity: 'error' | 'warning' }[]) => void,
  ) => [{ onValidation }],
}));

rs.mock('@/components/code-editor', () => ({
  CodeEditor: ({
    id,
    onChange,
    value,
    extensions,
    invalid,
  }: {
    id?: string;
    onChange?: (value: string) => void;
    value: string;
    invalid?: boolean;
    extensions?: Array<{
      onValidation: (draft: string, markers: readonly { readonly severity: 'error' | 'warning' }[]) => void;
    }>;
  }) => {
    useEffect(() => {
      const listener = extensions?.[0]?.onValidation;
      if (listener) validationMocks.requests.push({ resolve: (markers) => listener(value, markers) });
    }, [extensions, value]);

    return (
      <textarea
        id={id}
        value={value}
        aria-invalid={invalid ? 'true' : undefined}
        aria-describedby={invalid === true && id !== undefined ? `${id}-error` : undefined}
        onChange={(event) => onChange?.(event.target.value)}
      />
    );
  },
}));

const initialValue: readonly ProviderRequestTransformRule[] = [{ update: [{ $unset: 'request.body.store' }] }];

beforeEach(() => {
  validationMocks.requests.length = 0;
});

const resolveNextValidation = async (markers: readonly { readonly severity: 'error' | 'warning' }[] = []) => {
  await waitFor(() => expect(validationMocks.requests.length).toBeGreaterThan(0));
  const request = validationMocks.requests.shift();
  await act(async () => request?.resolve(markers));
};

const openJsonEditor = async () => {
  fireEvent.click(screen.getByRole('tab', { name: /JSON/u }));
  return await screen.findByRole('textbox', { name: /request rewrites json/i });
};

const renderEditor = async () => {
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  const view = render(
    <ProviderRequestTransformsEditor value={initialValue} onChange={onChange} onValidityChange={onValidityChange} />,
  );
  const editor = await openJsonEditor();
  await resolveNextValidation();
  if (onValidityChange.mock.calls.at(-1)?.[0] !== true) await resolveNextValidation();
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  onChange.mockClear();
  return { editor, onChange, onValidityChange, view };
};

test('starts in JSON when valid transforms cannot be rendered visually', async () => {
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  const value = [
    { update: [{ $set: { 'request.body.options': { retries: 2 } } }] },
  ] satisfies readonly ProviderRequestTransformRule[];

  render(<ProviderRequestTransformsEditor value={value} onChange={onChange} onValidityChange={onValidityChange} />);

  const editor = await screen.findByRole('textbox', { name: /request rewrites json/i });
  expect((editor as HTMLTextAreaElement).value).toContain('"retries": 2');
  expect(screen.getByRole('tab', { name: /Visual|可视化/u })).toHaveAttribute('aria-disabled', 'true');
  await resolveNextValidation();
  expect(onChange).not.toHaveBeenCalled();
});

test('reports a controlled JSON value as pending until the parent acknowledges it', async () => {
  const onValidationChange = rs.fn();
  const onValueChange = rs.fn(
    (nextValue: JsonValue | undefined, _draft: string, expectValueAcknowledgement: JsonEditorValueAcknowledgement) =>
      expectValueAcknowledgement(nextValue),
  );

  render(<JsonEditor value={{ mode: 'one' }} onValueChange={onValueChange} onValidationChange={onValidationChange} />);
  const editor = await screen.findByRole('textbox');
  await waitFor(() =>
    expect(onValidationChange).toHaveBeenLastCalledWith(expect.objectContaining({ valid: true }), expect.any(String)),
  );
  onValidationChange.mockClear();

  fireEvent.change(editor, { target: { value: '{"mode":"two"}' } });

  await waitFor(() => expect(onValueChange).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain('"mode": "one"'));
  expect(onValidationChange.mock.calls.some(([validation]) => !validation.valid && validation.pending)).toBe(true);
});

test('edits the request rule array without exposing the transforms wrapper', async () => {
  const { editor, onChange, onValidityChange } = await renderEditor();
  const visualTab = screen.getByRole('tab', { name: /Visual|可视化/u });
  expect((editor as HTMLTextAreaElement).value).toContain('"$unset": "request.body.store"');
  expect((editor as HTMLTextAreaElement).value).not.toContain('"request"');

  fireEvent.change(editor, { target: { value: '{' } });
  await resolveNextValidation();
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
  expect(visualTab).toHaveAttribute('aria-disabled', 'true');
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.change(editor, { target: { value: '[{"update":[{"$project":{"request.body":1}}]}]' } });
  await resolveNextValidation();
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('REQUEST_TRANSFORM_STAGE_INVALID');

  fireEvent.change(editor, { target: { value: '[{"update":[{"$set":{"request.body.store":false}}]}]' } });
  await resolveNextValidation();
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith([{ update: [{ $set: { 'request.body.store': false } }] }]),
  );
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  expect(visualTab).not.toHaveAttribute('aria-disabled', 'true');
});

test('clears a semantic issue when the JSON draft becomes malformed', async () => {
  const { editor, onChange, onValidityChange } = await renderEditor();

  fireEvent.change(editor, { target: { value: '[{"update":[{"$project":{"request.body":1}}]}]' } });
  await resolveNextValidation();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('REQUEST_TRANSFORM_STAGE_INVALID'));
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.change(editor, { target: { value: '{' } });

  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect((editor as HTMLTextAreaElement).value).toBe('{');
  expect(onChange).not.toHaveBeenCalled();
});

test('does not emit a Zod-valid candidate rejected by schema validation', async () => {
  const { editor, onChange, onValidityChange } = await renderEditor();

  fireEvent.change(editor, { target: { value: '[{"update":[{"$set":{"request.body.store":false}}]}]' } });
  expect(onChange).not.toHaveBeenCalled();
  await resolveNextValidation([{ severity: 'error' }]);

  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
  expect(onChange).not.toHaveBeenCalled();
});

test('does not let an older valid result emit a newer schema-invalid candidate', async () => {
  const { editor, onChange, onValidityChange } = await renderEditor();

  fireEvent.change(editor, { target: { value: '[{"update":[{"$set":{"request.body.first":true}}]}]' } });
  await waitFor(() => expect(validationMocks.requests.length).toBe(1));
  const older = validationMocks.requests.shift();

  fireEvent.change(editor, { target: { value: '[{"update":[{"$set":{"request.body.second":true}}]}]' } });
  await waitFor(() => expect(validationMocks.requests.length).toBe(1));
  const newer = validationMocks.requests.shift();

  await act(async () => newer?.resolve([{ severity: 'error' }]));
  await act(async () => older?.resolve([]));

  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
  expect(onChange).not.toHaveBeenCalled();
});

test('preserves the first draft when validity rerenders supply a fresh empty array', async () => {
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  let rerenderOnInvalid = false;
  let remainingRerenders = 1;
  let view: ReturnType<typeof render>;
  const handleValidityChange = (valid: boolean) => {
    onValidityChange(valid);
    if (!rerenderOnInvalid || valid || remainingRerenders === 0) return;
    remainingRerenders -= 1;
    queueMicrotask(() =>
      view.rerender(
        <ProviderRequestTransformsEditor value={[]} onChange={onChange} onValidityChange={handleValidityChange} />,
      ),
    );
  };
  view = render(
    <ProviderRequestTransformsEditor value={[]} onChange={onChange} onValidityChange={handleValidityChange} />,
  );
  const editor = await openJsonEditor();
  await resolveNextValidation();
  if (onValidityChange.mock.calls.at(-1)?.[0] !== true) await resolveNextValidation();
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  rerenderOnInvalid = true;
  onChange.mockClear();

  const nextValue = '[{"update":[{"$set":{"request.body.first":true}}]}]';
  fireEvent.change(editor, { target: { value: nextValue } });
  await waitFor(() => expect(remainingRerenders).toBe(0));
  await resolveNextValidation();

  await waitFor(() => expect(onChange).toHaveBeenCalledWith([{ update: [{ $set: { 'request.body.first': true } }] }]));
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('acknowledges an accepted emitted value without resetting the draft', async () => {
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  let view: ReturnType<typeof render>;
  const handleChange = (value: readonly ProviderRequestTransformRule[]) => {
    onChange(value);
    queueMicrotask(() =>
      view.rerender(
        <ProviderRequestTransformsEditor value={value} onChange={handleChange} onValidityChange={onValidityChange} />,
      ),
    );
  };
  view = render(
    <ProviderRequestTransformsEditor
      value={initialValue}
      onChange={handleChange}
      onValidityChange={onValidityChange}
    />,
  );
  const editor = await openJsonEditor();
  await resolveNextValidation();
  if (onValidityChange.mock.calls.at(-1)?.[0] !== true) await resolveNextValidation();
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  onChange.mockClear();

  const nextDraft = '[{"update":[{"$set":{"request.body.accepted":true}}]}]';
  fireEvent.change(editor, { target: { value: nextDraft } });
  await resolveNextValidation();

  await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe(nextDraft));
});

test('restores the controlled value when the parent rejects an emitted value', async () => {
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  let actionsDisabled = true;
  let view: ReturnType<typeof render>;
  const handleValidityChange = (valid: boolean) => {
    onValidityChange(valid);
    actionsDisabled = !valid;
  };
  const handleChange = (value: readonly ProviderRequestTransformRule[]) => {
    onChange(value);
    queueMicrotask(() =>
      view.rerender(
        <ProviderRequestTransformsEditor
          value={[...initialValue]}
          onChange={handleChange}
          onValidityChange={handleValidityChange}
        />,
      ),
    );
  };
  view = render(
    <ProviderRequestTransformsEditor
      value={initialValue}
      onChange={handleChange}
      onValidityChange={handleValidityChange}
    />,
  );
  const editor = await openJsonEditor();
  await resolveNextValidation();
  if (onValidityChange.mock.calls.at(-1)?.[0] !== true) await resolveNextValidation();
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  onChange.mockClear();

  fireEvent.change(editor, { target: { value: '[{"update":[{"$set":{"request.body.rejected":true}}]}]' } });
  await resolveNextValidation();

  await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain('"$unset": "request.body.store"'));
  await waitFor(() => expect(actionsDisabled).toBe(true));
  await resolveNextValidation();
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  expect(actionsDisabled).toBe(false);
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('resynchronizes the draft when external canonical content changes', async () => {
  const { editor, onChange, onValidityChange, view } = await renderEditor();
  const externalValue: readonly ProviderRequestTransformRule[] = [
    { update: [{ $unset: 'request.body.externally-replaced' }] },
  ];

  view.rerender(
    <ProviderRequestTransformsEditor value={externalValue} onChange={onChange} onValidityChange={onValidityChange} />,
  );

  await waitFor(() =>
    expect((editor as HTMLTextAreaElement).value).toContain('"$unset": "request.body.externally-replaced"'),
  );
  await resolveNextValidation();
  if (onValidityChange.mock.calls.at(-1)?.[0] !== true) await resolveNextValidation();
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  expect(onChange).not.toHaveBeenCalled();
});

test('explains why valid JSON cannot open in the visual editor', async () => {
  const unsupported = m['dashboard.providers.transforms.unsupported']();
  const view = render(
    <ProviderRequestTransformsEditor
      value={[{ update: [{ $set: { 'request.body.options': { retries: 2 } } }] }]}
      onChange={rs.fn()}
      onValidityChange={rs.fn()}
    />,
  );
  await screen.findByRole('textbox', { name: /request rewrites json/i });
  expect(screen.getByText(unsupported)).toBeInTheDocument();
  view.unmount();

  render(
    <ProviderRequestTransformsEditor
      value={[{ update: [{ $unset: 'request.body.store' }] }]}
      onChange={rs.fn()}
      onValidityChange={rs.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('tab', { name: /JSON/u }));
  await screen.findByRole('textbox', { name: /request rewrites json/i });
  expect(screen.queryByText(unsupported)).toBeNull();
});

test('describes a non-array JSON draft through the editor error id', async () => {
  const { editor } = await renderEditor();
  const invalidArray = m['dashboard.providers.transforms.invalid_array']();

  fireEvent.change(editor, { target: { value: '{}' } });
  await resolveNextValidation();
  await waitFor(() => expect(screen.getByText(invalidArray)).toBeInTheDocument());
  const describedBy = editor.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  const error = document.getElementById(describedBy!);
  expect(error).not.toBeNull();
  expect(error).toHaveTextContent(invalidArray);

  fireEvent.change(editor, { target: { value: '[{"update":[{"$project":{"request.body":1}}]}]' } });
  await resolveNextValidation();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('REQUEST_TRANSFORM_STAGE_INVALID'));
  expect(screen.queryByText(invalidArray)).not.toBeInTheDocument();
});

test('starts in JSON when a body-root replacement cannot be rendered visually', async () => {
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  const value = [
    { update: [{ $set: { 'request.body': { a: 1 } } }] },
  ] satisfies readonly ProviderRequestTransformRule[];

  render(<ProviderRequestTransformsEditor value={value} onChange={onChange} onValidityChange={onValidityChange} />);

  const editor = await screen.findByRole('textbox', { name: /request rewrites json/i });
  expect((editor as HTMLTextAreaElement).value).toContain('"request.body"');
  expect(screen.getByRole('tab', { name: /Visual|可视化/u })).toHaveAttribute('aria-disabled', 'true');
  await resolveNextValidation();
  expect(onChange).not.toHaveBeenCalled();
});
