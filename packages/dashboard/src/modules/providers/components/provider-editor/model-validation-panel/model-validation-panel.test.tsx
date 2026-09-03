import { m } from '@aio-proxy/i18n';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import type { ReactNode } from 'react';

import {
  type ProviderEditorForm,
  type ProviderEditorInitial,
  useProviderEditorForm,
} from '../../../hooks/use-provider-editor-form';
import { ModelValidationPanel } from './model-validation-panel';

const mocks = rs.hoisted(() => ({ testDraft: rs.fn() }));

rs.mock('../../../services/provider-draft', () => ({
  testProviderDraftModel: mocks.testDraft,
}));

const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
let validationForm: ProviderEditorForm;
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

interface HarnessProps {
  readonly kind: ProviderKind;
  readonly initial: ProviderEditorInitial;
  readonly testableModels: readonly string[];
  readonly persistedProviderId: string | undefined;
}

const Harness: React.FC<HarnessProps> = ({ kind, initial, testableModels, persistedProviderId }) => {
  const form = useProviderEditorForm({ kind, initial });
  validationForm = form;
  return (
    <ModelValidationPanel
      form={form}
      kind={kind}
      persistedProviderId={persistedProviderId}
      testableModels={testableModels}
    />
  );
};

const apiInitial = (models: readonly string[], alias?: ProviderEditorInitial['alias']): ProviderEditorInitial => ({
  kind: ProviderKind.Api,
  id: 'provider',
  protocol: ProviderProtocol.OpenAICompatible,
  baseURL: 'https://api.example/v1',
  models,
  ...(alias === undefined ? {} : { alias }),
});

const oauthInitial = (models: readonly string[]): ProviderEditorInitial => ({
  kind: ProviderKind.OAuth,
  id: 'oauth-p',
  enabled: true,
  models,
});

describe('ModelValidationPanel', () => {
  beforeEach(() => {
    mocks.testDraft.mockReset();
    queryClient.clear();
  });

  test('the oauth panel renders the saved-account note', () => {
    render(
      <Harness
        kind={ProviderKind.OAuth}
        initial={oauthInitial(['m1'])}
        testableModels={['m1']}
        persistedProviderId="oauth-p"
      />,
      { wrapper },
    );

    expect(screen.getByText(/The test uses the saved account|测试使用已保存的账户/u)).toBeTruthy();
  });

  test('the oauth saved-account note disappears when no model is testable', () => {
    render(
      <Harness
        kind={ProviderKind.OAuth}
        initial={oauthInitial([])}
        testableModels={[]}
        persistedProviderId="oauth-p"
      />,
      { wrapper },
    );

    expect(screen.queryByText(m['dashboard.providers.editor.test_checks_saved_account']())).toBeNull();
  });

  test('hides the test button when no model is testable', () => {
    render(
      <Harness kind={ProviderKind.Api} initial={apiInitial([])} testableModels={[]} persistedProviderId="provider" />,
      { wrapper },
    );

    expect(screen.queryByRole('button', { name: /Test model request|测试模型请求/u })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(m['dashboard.providers.editor.validate_unavailable']());
  });

  test('the model select has no visible label but keeps its accessible name', () => {
    render(
      <Harness
        kind={ProviderKind.Api}
        initial={apiInitial(['model-a'])}
        testableModels={['model-a']}
        persistedProviderId="provider"
      />,
      { wrapper },
    );

    expect(screen.queryByText(m['dashboard.providers.editor.validate_model']())).toBeNull();
    expect(screen.getByRole('combobox', { name: /Model to test|测试模型/u })).toBeTruthy();
  });

  test('disables model changes while testing', async () => {
    let resolveTest: ((value: { readonly ok: true }) => void) | undefined;
    mocks.testDraft.mockImplementation(
      () =>
        new Promise<{ readonly ok: true }>((resolve) => {
          resolveTest = resolve;
        }),
    );
    render(
      <Harness
        kind={ProviderKind.Api}
        initial={apiInitial(['model-a', 'model-b'])}
        testableModels={['model-a', 'model-b']}
        persistedProviderId="provider"
      />,
      { wrapper },
    );

    const testButton = () => screen.getByRole('button', { name: /Test model request|测试模型请求/u });
    fireEvent.click(testButton());
    await waitFor(() => expect(testButton()).toBeDisabled());
    // rail16: pending adds a spinner and must not rename the button. Pin the text content, not the
    // accessible name — that absorbs the spinner's own "Loading" label — and pin it exactly, or a
    // pending copy that merely wraps the action name still matches in some locales.
    expect(testButton().textContent?.trim()).toBe(m['dashboard.providers.editor.validate_action']());
    const modelWasDisabled = screen.getByRole('combobox', { name: /Model to test|测试模型/u }).hasAttribute('disabled');

    act(() => resolveTest?.({ ok: true }));
    await screen.findByRole('status');
    expect(modelWasDisabled).toBe(true);
  });

  test('hides a result after selecting a model that was not tested', async () => {
    mocks.testDraft.mockResolvedValue({ ok: true });
    render(
      <Harness
        kind={ProviderKind.Api}
        initial={apiInitial(['model-a', 'model-b'])}
        testableModels={['model-a', 'model-b']}
        persistedProviderId="provider"
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: /Test model request|测试模型请求/u }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Request succeeded · model-a|请求成功 · model-a/u);

    act(() => validationForm.setFieldValue('validationModel', 'model-b'));
    // Deliberately broad: this asserts the line disappears for an untested selection, so pinning it to
    // model-a would let a bug that re-renders success for model-b pass. The `· model-a` pin lives on the
    // two positive assertions.
    await waitFor(() => expect(screen.queryByText(/Request succeeded|请求成功/u)).toBeNull());
  });

  test('announces a recoverable request error without gating the form', async () => {
    mocks.testDraft.mockRejectedValue(new Error('offline'));
    render(
      <Harness
        kind={ProviderKind.Api}
        initial={apiInitial(['model-a', 'model-b'])}
        testableModels={['model-a', 'model-b']}
        persistedProviderId="provider"
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: /Test model request|测试模型请求/u }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/test_request_failed/u));
  });

  test('an oauth Test click sends the five-field draft and persistedProviderId', async () => {
    mocks.testDraft.mockResolvedValue({ ok: true });
    render(
      <Harness
        kind={ProviderKind.OAuth}
        initial={{ ...oauthInitial(['m1']), validationModel: 'm1' }}
        testableModels={['m1']}
        persistedProviderId="oauth-p"
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: /Test model request|测试模型请求/u }));
    await waitFor(() => expect(mocks.testDraft).toHaveBeenCalled());

    expect(mocks.testDraft).toHaveBeenCalledWith({
      draft: { kind: 'oauth', id: 'oauth-p', enabled: true, proxy: null, excludedModels: [] },
      model: 'm1',
      persistedProviderId: 'oauth-p',
    });
  });

  test('a failed result is distinguishable from a passing one without reading the text', async () => {
    mocks.testDraft.mockRejectedValue(new Error('offline'));
    const failed = render(
      <Harness
        kind={ProviderKind.Api}
        initial={apiInitial(['model-a'])}
        testableModels={['model-a']}
        persistedProviderId="provider"
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: /Test model request|测试模型请求/u }));
    await waitFor(() => expect(screen.getByRole('alert').className).toContain('text-destructive'));
    failed.unmount();
    queryClient.clear();

    mocks.testDraft.mockResolvedValue({ ok: true });
    render(
      <Harness
        kind={ProviderKind.Api}
        initial={apiInitial(['model-a'])}
        testableModels={['model-a']}
        persistedProviderId="provider"
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: /Test model request|测试模型请求/u }));
    // Scoped to the message, not merely to the absence of a class: `not.toContain` alone also passes
    // for a success region that renders nothing, or the failure text under a non-destructive class.
    // Same query and same pattern as the success assertion earlier in this file.
    expect(await screen.findByRole('status')).toHaveTextContent(/Request succeeded · model-a|请求成功 · model-a/u);
    expect((await screen.findByRole('status')).className).not.toContain('text-destructive');
  });

  test('an api fixture with an alias offers the upstream model id, not the alias', async () => {
    render(
      <Harness
        kind={ProviderKind.Api}
        initial={apiInitial(['my-model'], { 'gpt-4': { model: 'my-model', preserve: false } })}
        testableModels={['my-model']}
        persistedProviderId="provider"
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('combobox', { name: /Model to test|测试模型/u }));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['my-model']);
  });

  test('an oauth empty whitelist offers the catalog rather than validate_unavailable', () => {
    render(
      <Harness
        kind={ProviderKind.OAuth}
        initial={oauthInitial([])}
        testableModels={['disc-a', 'disc-b']}
        persistedProviderId="oauth-p"
      />,
      { wrapper },
    );

    expect(
      screen.queryByText(
        /Enable at least one model before you can test a request\.|先启用至少一个模型，才能测试请求。/u,
      ),
    ).toBeNull();
    expect(screen.getByRole('combobox', { name: /Model to test|测试模型/u })).toBeTruthy();
  });
});
