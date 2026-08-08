import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import type { ReactNode } from 'react';

import { type ProviderForm, useProviderForm } from '../../hooks/use-provider-form';
import { ProviderFormMode } from '../../lib/constants';
import { ProviderValidateStep } from './provider-validate-step';

const mocks = rs.hoisted(() => ({ testDraft: rs.fn() }));

rs.mock('../../services/provider-draft', () => ({
  testProviderDraftModel: mocks.testDraft,
}));

const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
let validationForm: ProviderForm;
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

const ValidateStepHarness: React.FC = () => {
  const form = useProviderForm({
    mode: ProviderFormMode.Edit,
    kind: ProviderKind.Api,
    initial: {
      baseURL: 'https://api.example/v1',
      id: 'provider',
      kind: ProviderKind.Api,
      models: ['model-a', 'model-b'],
      protocol: ProviderProtocol.OpenAICompatible,
    },
  });
  validationForm = form;
  return <ProviderValidateStep form={form} persistedProviderId="provider" />;
};

describe('Provider validate step', () => {
  beforeEach(() => {
    mocks.testDraft.mockReset();
    queryClient.clear();
  });

  test('disables model changes while testing', async () => {
    let resolveTest: ((value: { readonly ok: true }) => void) | undefined;
    mocks.testDraft.mockImplementation(
      () =>
        new Promise<{ readonly ok: true }>((resolve) => {
          resolveTest = resolve;
        }),
    );
    render(<ValidateStepHarness />, { wrapper });

    fireEvent.click(screen.getByRole('button', { name: /Test connection|测试连接/u }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Testing connection|正在测试连接/u })).toBeDisabled(),
    );
    const modelWasDisabled = screen.getByRole('combobox', { name: /Model to test|测试模型/u }).hasAttribute('disabled');

    act(() => resolveTest?.({ ok: true }));
    await screen.findByRole('status');
    expect(modelWasDisabled).toBe(true);
  });

  test('hides a result after selecting a model that was not tested', async () => {
    mocks.testDraft.mockResolvedValue({ ok: true });
    render(<ValidateStepHarness />, { wrapper });

    fireEvent.click(screen.getByRole('button', { name: /Test connection|测试连接/u }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Connection test succeeded|连接测试成功/u);

    act(() => validationForm.setFieldValue('validationModel', 'model-b'));
    await waitFor(() => expect(screen.queryByText(/Connection test succeeded|连接测试成功/u)).toBeNull());
  });

  test('announces a recoverable request error without gating the form', async () => {
    mocks.testDraft.mockRejectedValue(new Error('offline'));
    render(<ValidateStepHarness />, { wrapper });

    fireEvent.click(screen.getByRole('button', { name: /Test connection|测试连接/u }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/test_request_failed/u));
  });
});
