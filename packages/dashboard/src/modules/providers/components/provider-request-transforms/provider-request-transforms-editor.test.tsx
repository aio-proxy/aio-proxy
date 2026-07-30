import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { beforeEach, expect, rs, test } from '@rstest/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';

import { ProviderRequestTransformsEditor } from './provider-request-transforms-editor';

const validationMocks = rs.hoisted(() => ({
  requests: [] as Array<{
    readonly promise: Promise<readonly { readonly severity: 'error' | 'warning' }[]>;
    readonly resolve: (markers: readonly { readonly severity: 'error' | 'warning' }[]) => void;
  }>,
}));

rs.mock('@/components/json-editor/json-schema-registry', () => ({
  registerJsonSchema: () => () => undefined,
  validateJsonModel: () => {
    let resolve!: (markers: readonly { readonly severity: 'error' | 'warning' }[]) => void;
    const promise = new Promise<readonly { readonly severity: 'error' | 'warning' }[]>((nextResolve) => {
      resolve = nextResolve;
    });
    validationMocks.requests.push({ promise, resolve });
    return promise;
  },
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

const initialValue: readonly ProviderRequestTransformRule[] = [{ update: [{ $unset: 'request.body.store' }] }];

beforeEach(() => {
  validationMocks.requests.length = 0;
});

const resolveNextValidation = async (markers: readonly { readonly severity: 'error' | 'warning' }[] = []) => {
  await waitFor(() => expect(validationMocks.requests.length).toBeGreaterThan(0));
  const request = validationMocks.requests.shift();
  await act(async () => request?.resolve(markers));
};

const renderEditor = async () => {
  const onChange = rs.fn();
  const onValidityChange = rs.fn();
  const view = render(
    <ProviderRequestTransformsEditor value={initialValue} onChange={onChange} onValidityChange={onValidityChange} />,
  );
  const editor = await screen.findByRole('textbox', { name: /request transforms json/i });
  await resolveNextValidation();
  if (onValidityChange.mock.calls.at(-1)?.[0] !== true) await resolveNextValidation();
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  onChange.mockClear();
  return { editor, onChange, onValidityChange, view };
};

test('edits the request rule array without exposing the transforms wrapper', async () => {
  const { editor, onChange, onValidityChange } = await renderEditor();
  expect((editor as HTMLTextAreaElement).value).toContain('"$unset": "request.body.store"');
  expect((editor as HTMLTextAreaElement).value).not.toContain('"request"');

  fireEvent.change(editor, { target: { value: '{' } });
  await resolveNextValidation();
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
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
});

test('does not emit a Zod-valid candidate rejected by Monaco schema validation', async () => {
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
  const editor = await screen.findByRole('textbox', { name: /request transforms json/i });
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
