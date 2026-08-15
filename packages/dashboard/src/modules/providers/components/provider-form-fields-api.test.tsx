import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { describe, expect, rs, test } from '@rstest/core';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';

import { useProviderEditorForm } from '../hooks/use-provider-editor-form';
// The submit-normalization cases below still need useProviderForm: the editor hook has no onSubmit.
import { parseProviderFormInitial, useProviderForm } from '../hooks/use-provider-form';
import { ProviderFormMode } from '../lib/constants';
import { ProviderFormFieldsApi } from './provider-form-fields-api';

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

  test('hydrates and submits the canonical baseURL field when editing', async () => {
    const onSubmit = rs.fn();
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
    const { result } = renderHook(() =>
      useProviderForm({
        mode: ProviderFormMode.Edit,
        kind: ProviderKind.Api,
        initial,
        onSubmit,
      }),
    );

    render(<ProviderFormFieldsApi form={result.current} mode={ProviderFormMode.Edit} />);

    const baseURLInput = within(screen.getByTestId('provider-form-field-baseURL')).getByRole('textbox');
    expect(baseURLInput).toHaveValue('https://openrouter.example/v1');

    fireEvent.change(baseURLInput, { target: { value: 'https://updated.example/v1' } });
    await act(async () => {
      await result.current.handleSubmit();
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0]?.[0];
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
  ])('round-trips the configured proxy when submitting a $kind provider edit', async ({ kind, initial }) => {
    const onSubmit = rs.fn();
    const parsed = parseProviderFormInitial(initial);
    expect(parsed?.proxy).toBe('https://proxy.example:8443');
    const { result } = renderHook(() =>
      useProviderForm({ mode: ProviderFormMode.Edit, kind, initial: parsed, onSubmit }),
    );

    await act(async () => result.current.handleSubmit());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ proxy: 'https://proxy.example:8443' });
  });
});
