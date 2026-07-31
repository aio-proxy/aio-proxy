import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { describe, expect, rs, test } from '@rstest/core';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';

import { ProviderFormMode } from '../constants';
import { parseProviderFormInitial, useProviderForm } from '../hooks/use-provider-form';
import { ProviderFormFieldsApi } from './provider-form-fields-api';

rs.mock('./provider-request-transforms/provider-request-transforms-editor', () => ({
  ProviderRequestTransformsEditor: () => null,
}));

describe('API provider form fields', () => {
  test('shows a protocol placeholder and icons in the options and selected value', async () => {
    const { result } = renderHook(() => useProviderForm({ mode: ProviderFormMode.Create, kind: ProviderKind.Api }));

    render(
      <ProviderFormFieldsApi
        form={result.current}
        mode={ProviderFormMode.Create}
        aliasOpen={false}
        onAliasOpenChange={rs.fn()}
        onTransformsValidityChange={rs.fn()}
      />,
    );

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

    render(
      <ProviderFormFieldsApi
        form={result.current}
        mode={ProviderFormMode.Edit}
        providerId="openrouter"
        aliasOpen={false}
        onAliasOpenChange={rs.fn()}
        onTransformsValidityChange={rs.fn()}
      />,
    );

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

  test('groups edit fields and omits the immutable Provider ID input', () => {
    const { result } = renderHook(() =>
      useProviderForm({
        mode: ProviderFormMode.Edit,
        kind: ProviderKind.Api,
        initial: { kind: ProviderKind.Api, id: 'openrouter', enabled: true },
      }),
    );

    render(
      <ProviderFormFieldsApi
        form={result.current}
        mode={ProviderFormMode.Edit}
        providerId="openrouter"
        aliasOpen={false}
        onAliasOpenChange={rs.fn()}
        onTransformsValidityChange={rs.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: /Basic information|基本信息/u })).toBeTruthy();
    expect(screen.getByRole('region', { name: /Connection|连接/u })).toBeTruthy();
    expect(screen.getByRole('region', { name: /Models and aliases|模型与别名/u })).toBeTruthy();
    expect(screen.queryByLabelText(/Provider ID|提供商 ID/u)).toBeNull();
  });
});
