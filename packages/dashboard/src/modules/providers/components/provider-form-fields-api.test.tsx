import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';

import { ProviderFormMode } from '../constants';
import { parseProviderFormInitial, useProviderForm } from '../hooks/use-provider-form';
import { ProviderFormFieldsApi } from './provider-form-fields-api';

const mocks = rs.hoisted(() => ({ fetchCatalog: rs.fn() }));

rs.mock('../services/provider-draft', () => ({
  fetchProviderDraftCatalog: mocks.fetchCatalog,
}));

rs.mock('./provider-request-transforms/provider-request-transforms-editor', () => ({
  ProviderRequestTransformsEditor: () => null,
}));

const renderWithQueryClient = (element: ReactElement) => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrap = (child: ReactElement) => <QueryClientProvider client={queryClient}>{child}</QueryClientProvider>;
  const view = render(wrap(element));
  return { ...view, rerender: (nextElement: ReactElement) => view.rerender(wrap(nextElement)) };
};

describe('API provider form fields', () => {
  beforeEach(() => mocks.fetchCatalog.mockReset());

  test('shows a protocol placeholder and icons in the options and selected value', async () => {
    const { result } = renderHook(() => useProviderForm({ mode: ProviderFormMode.Create, kind: ProviderKind.Api }));

    renderWithQueryClient(
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

    renderWithQueryClient(
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

  test('shows only the active connection step and omits the immutable Provider ID input', () => {
    const { result } = renderHook(() =>
      useProviderForm({
        mode: ProviderFormMode.Edit,
        kind: ProviderKind.Api,
        initial: { kind: ProviderKind.Api, id: 'openrouter', enabled: true },
      }),
    );

    renderWithQueryClient(
      <ProviderFormFieldsApi
        form={result.current}
        mode={ProviderFormMode.Edit}
        providerId="openrouter"
        aliasOpen={false}
        onAliasOpenChange={rs.fn()}
        onTransformsValidityChange={rs.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: /Connection|连接/u })).toBeTruthy();
    expect(screen.queryByRole('region', { name: /Models and aliases|模型与别名/u })).toBeNull();
    expect(screen.queryByLabelText(/Provider ID|提供商 ID/u)).toBeNull();
  });

  test.each([
    {
      kind: ProviderKind.Api,
      initial: {
        kind: ProviderKind.Api,
        id: 'api-provider',
        protocol: ProviderProtocol.OpenAICompatible,
        baseURL: 'https://api.example/v1',
        proxy: '****',
      },
    },
    {
      kind: ProviderKind.AiSdk,
      initial: {
        kind: ProviderKind.AiSdk,
        id: 'sdk-provider',
        packageName: '@ai-sdk/openai-compatible',
        proxy: '****',
      },
    },
  ])('omits the redacted proxy when submitting a $kind provider edit', async ({ kind, initial }) => {
    const onSubmit = rs.fn();
    const parsed = parseProviderFormInitial(initial);
    expect(parsed?.proxy).toBe('****');
    const { result } = renderHook(() =>
      useProviderForm({ mode: ProviderFormMode.Edit, kind, initial: parsed, onSubmit }),
    );

    await act(async () => result.current.handleSubmit());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('proxy');
  });

  test('enables catalog models, accepts unique pasted models, and edits per-model metadata', async () => {
    mocks.fetchCatalog.mockResolvedValue({ ok: true, models: ['catalog-a', 'catalog-b'] });
    const { result } = renderHook(() =>
      useProviderForm({
        mode: ProviderFormMode.Edit,
        kind: ProviderKind.Api,
        initial: {
          kind: ProviderKind.Api,
          id: 'provider',
          protocol: ProviderProtocol.OpenAICompatible,
          baseURL: 'https://api.example/v1',
          models: ['existing'],
        },
      }),
    );

    renderWithQueryClient(
      <ProviderFormFieldsApi
        form={result.current}
        mode={ProviderFormMode.Edit}
        providerId="provider"
        activeStep={1}
        aliasOpen={false}
        onAliasOpenChange={rs.fn()}
        onTransformsValidityChange={rs.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Load model catalog|加载模型目录/u }));
    const catalogModel = await screen.findByRole('checkbox', { name: 'catalog-a' });
    fireEvent.click(catalogModel);
    await waitFor(() => expect(result.current.getFieldValue('models')).toEqual(['existing', 'catalog-a']));

    const manualInput = screen.getByRole('combobox', { name: /Add models manually|手动添加模型/u });
    fireEvent.paste(manualInput, { clipboardData: { getData: () => 'a,b\nc,a' } });
    await waitFor(() =>
      expect(result.current.getFieldValue('models')).toEqual(['existing', 'catalog-a', 'a', 'b', 'c']),
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit metadata for catalog-a|编辑 catalog-a 的元数据/u }));
    expect(await screen.findByTestId('provider-model-metadata-drawer')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Metadata JSON for catalog-a|catalog-a 的元数据 JSON/u })).toHaveValue(
      '{}',
    );
  });

  test('keeps manual model entry usable after a recoverable catalog failure', async () => {
    mocks.fetchCatalog.mockResolvedValue({
      ok: false,
      error: { code: 'catalog_unavailable', recoverable: true },
    });
    const { result } = renderHook(() =>
      useProviderForm({
        mode: ProviderFormMode.Create,
        kind: ProviderKind.Api,
        initial: {
          kind: ProviderKind.Api,
          id: 'provider',
          protocol: ProviderProtocol.OpenAICompatible,
          baseURL: 'https://api.example/v1',
        },
      }),
    );

    renderWithQueryClient(
      <ProviderFormFieldsApi
        form={result.current}
        mode={ProviderFormMode.Create}
        activeStep={1}
        aliasOpen={false}
        onAliasOpenChange={rs.fn()}
        onTransformsValidityChange={rs.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Load model catalog|加载模型目录/u }));
    expect(await screen.findByRole('status')).toHaveTextContent(/unavailable|不可用/u);

    const manualInput = screen.getByRole('combobox', { name: /Add models manually|手动添加模型/u });
    fireEvent.paste(manualInput, { clipboardData: { getData: () => 'a,b\nc' } });
    await waitFor(() => expect(result.current.getFieldValue('models')).toEqual(['a', 'b', 'c']));
  });

  test('keeps the existing Alias drawer available across multiple enabled models', async () => {
    const { result } = renderHook(() =>
      useProviderForm({
        mode: ProviderFormMode.Edit,
        kind: ProviderKind.Api,
        initial: {
          kind: ProviderKind.Api,
          id: 'provider',
          protocol: ProviderProtocol.OpenAICompatible,
          baseURL: 'https://api.example/v1',
          models: ['model-a', 'model-b'],
          alias: { public: { model: 'model-a', preserve: false } },
        },
      }),
    );

    const view = renderWithQueryClient(
      <ProviderFormFieldsApi
        form={result.current}
        mode={ProviderFormMode.Edit}
        activeStep={1}
        aliasOpen={false}
        onAliasOpenChange={(open) => {
          view.rerender(
            <ProviderFormFieldsApi
              form={result.current}
              mode={ProviderFormMode.Edit}
              activeStep={1}
              aliasOpen={open}
              onAliasOpenChange={rs.fn()}
              onTransformsValidityChange={rs.fn()}
            />,
          );
        }}
        onTransformsValidityChange={rs.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit Aliases|编辑别名/u }));
    const drawer = await screen.findByTestId('provider-alias-drawer');
    fireEvent.click(within(drawer).getByRole('combobox', { name: /Target Model|目标模型/u }));
    expect(await screen.findByRole('option', { name: 'model-a' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'model-b' })).toBeInTheDocument();
  });
});
