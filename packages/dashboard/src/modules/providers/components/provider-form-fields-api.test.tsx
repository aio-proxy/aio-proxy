import { ProviderKind, ProviderMutationBodySchema, ProviderProtocol } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';

import { useProviderEditorForm, type ProviderEditorShape } from '../hooks/use-provider-editor-form';
import {
  normalizeProviderFormValue,
  parseProviderFormInitial,
  type ProviderFormShape,
} from '../hooks/use-provider-form';
import { ProviderFormMode } from '../lib/constants';
import { ProviderFormFieldsApi } from './provider-form-fields-api';

// The editor form is seed-only by design, so there is no onSubmit to spy on. This is the body the
// live save actually sends: `saveConfigProvider` runs exactly this normalize + parse over form
// values (use-provider-editor-page.ts), so asserting on it pins the real submit contract.
const mutationBody = (values: ProviderEditorShape) => {
  const result = ProviderMutationBodySchema.safeParse(normalizeProviderFormValue(values as ProviderFormShape));
  expect(result.success).toBe(true);
  return result.success ? result.data : undefined;
};

describe('API provider form fields', () => {
  test('shows a protocol placeholder and icons in the options and selected value', async () => {
    const { result } = renderHook(() => useProviderEditorForm({ kind: ProviderKind.Api }));

    render(<ProviderFormFieldsApi form={result.current} mode={ProviderFormMode.Create} />);

    const protocolField = screen.getByTestId('provider-form-field-protocol');
    const trigger = within(protocolField).getByRole('combobox');
    expect(trigger).toHaveTextContent(/Select a protocol|请选择协议/u);

    fireEvent.click(trigger);
    const option = await screen.findByRole('option', { name: 'OpenAI Response' });
    expect(option.querySelector('img')).toHaveAttribute('alt', '');
    fireEvent.click(option);

    await waitFor(() => expect(trigger).toHaveTextContent('OpenAI Response'));
    expect(trigger.querySelector('img')).toHaveAttribute('alt', '');
  });

  test('pairs the protocol and base URL fields on one row, with the API key below it', () => {
    const { result } = renderHook(() => useProviderEditorForm({ kind: ProviderKind.Api }));

    render(<ProviderFormFieldsApi form={result.current} mode={ProviderFormMode.Create} />);

    // jsdom has no layout, so the shared row element and its column template are the only evidence
    // that these two fields are paired; a stacked layout passes every other assertion here.
    const row = screen.getByTestId('provider-form-field-protocol').parentElement;
    expect(screen.getByTestId('provider-form-field-baseURL').parentElement).toBe(row);
    expect(row?.className).toContain('grid');
    expect(row?.className).toContain('sm:grid-cols-[minmax(0,15rem)_1fr]');
    expect(screen.getByTestId('provider-form-field-apiKey').parentElement).not.toBe(row);
  });

  test('hydrates the canonical baseURL field and carries an edit into the mutation body', async () => {
    const initial = parseProviderFormInitial({
      kind: ProviderKind.Api,
      id: 'openrouter',
      enabled: true,
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: 'https://openrouter.example/v1',
      proxy: false,
      hasApiKey: true,
    });
    expect(initial).toBeDefined();
    const { result } = renderHook(() => useProviderEditorForm({ kind: ProviderKind.Api, initial }));

    render(<ProviderFormFieldsApi form={result.current} mode={ProviderFormMode.Edit} />);

    const baseURLInput = within(screen.getByTestId('provider-form-field-baseURL')).getByRole('textbox');
    expect(baseURLInput).toHaveValue('https://openrouter.example/v1');

    fireEvent.change(baseURLInput, { target: { value: 'https://updated.example/v1' } });
    await waitFor(() => expect(baseURLInput).toHaveValue('https://updated.example/v1'));

    const submitted = mutationBody(result.current.state.values);
    expect(submitted).toMatchObject({ baseURL: 'https://updated.example/v1' });
    expect(submitted).not.toHaveProperty('baseUrl');
    expect(submitted).not.toHaveProperty('hasApiKey');
  });

  test('keeps a stored API key retained when editing and never renders a clear control', () => {
    const { result } = renderHook(() =>
      useProviderEditorForm({
        kind: ProviderKind.Api,
        initial: { kind: ProviderKind.Api, id: 'openrouter', enabled: true },
      }),
    );

    render(<ProviderFormFieldsApi form={result.current} mode={ProviderFormMode.Edit} />);

    const apiKeyField = screen.getByTestId('provider-form-field-apiKey');
    expect(within(apiKeyField).getByLabelText(/API Key/u)).toHaveValue('');
    expect(apiKeyField.textContent).toMatch(/empty|留空/u);
    expect(within(apiKeyField).queryByRole('button')).toBeNull();
  });

  test.each([
    {
      kind: ProviderKind.Api,
      initial: {
        kind: ProviderKind.Api,
        id: 'api-provider',
        protocol: ProviderProtocol.OpenAICompatible,
        baseURL: 'https://api.example/v1',
        proxy: 'https://proxy.example:8443',
      },
    },
    {
      kind: ProviderKind.AiSdk,
      initial: {
        kind: ProviderKind.AiSdk,
        id: 'sdk-provider',
        packageName: '@ai-sdk/openai-compatible',
        proxy: 'https://proxy.example:8443',
      },
    },
  ])('round-trips the configured proxy into a $kind provider mutation body', ({ kind, initial }) => {
    const parsed = parseProviderFormInitial(initial);
    expect(parsed?.proxy).toBe('https://proxy.example:8443');
    const { result } = renderHook(() => useProviderEditorForm({ kind, initial: parsed }));

    expect(mutationBody(result.current.state.values)).toMatchObject({ proxy: 'https://proxy.example:8443' });
  });
});
