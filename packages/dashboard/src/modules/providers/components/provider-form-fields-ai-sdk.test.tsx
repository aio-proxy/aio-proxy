import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { type ProviderEditorInitial, useProviderEditorForm } from '../hooks/use-provider-editor-form';
import { ProviderFormFieldsAiSdk } from './provider-form-fields-ai-sdk';

const mocks = rs.hoisted(() => ({ install: rs.fn(), status: rs.fn() }));

// The component is mounted for real and only the package endpoints are stubbed: the defect this file
// pins lives in the mount effect's interaction with the blur handler, so a unit test over
// `commitProviderPackageOnce` with a hand-built ref passes while the component still installs.
rs.mock('../services/provider-options-schema-service', () => ({
  providerPackageStatusQueryOptions: (packageName: string) => ({
    queryKey: ['provider-package-status', packageName],
    queryFn: () => mocks.status(packageName),
  }),
  installProviderPackage: mocks.install,
  ProviderPackageRequestError: class ProviderPackageRequestError extends Error {},
}));

// The options editor mounts an editor that reaches for a CDN loader happy-dom refuses to run.
rs.mock('@monaco-editor/react', () => ({
  Editor: ({ options, value }: { readonly options?: { readonly ariaLabel?: string }; readonly value?: string }) => (
    <textarea aria-label={options?.ariaLabel} value={value} readOnly />
  ),
}));

const queryClient = new QueryClient({
  defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
});
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

const Harness: React.FC<{ readonly initial: ProviderEditorInitial }> = ({ initial }) => {
  const form = useProviderEditorForm({ kind: ProviderKind.AiSdk, initial });
  return <ProviderFormFieldsAiSdk form={form} />;
};

const packageInput = () => screen.getByRole('combobox');
// Rendered only in install_required / install_deferred / install_error, so its presence is evidence the
// mount commit's status check landed on "deferred" rather than having started an install.
const deferredInstallButton = () =>
  screen.getByRole('button', { name: m['dashboard.providers.form.options_install_package']() });

// The commit -> status -> install chain is several microtask turns deep, so a bare assertion after
// blur would pass before the install it is meant to forbid could have been requested.
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

describe('ProviderFormFieldsAiSdk package commits', () => {
  beforeEach(() => {
    queryClient.clear();
    mocks.install.mockReset();
    // Trusted and absent: the only status under which a commit that allows automatic install starts
    // one. Any other status would make the negative assertion below vacuous.
    mocks.status.mockReset();
    mocks.status.mockResolvedValue({ trusted: true, state: 'missing' });
    mocks.install.mockResolvedValue({ installed: true });
  });

  test('focus and blur with no keystroke does not install the existing package', async () => {
    render(<Harness initial={{ kind: ProviderKind.AiSdk, packageName: '@ai-sdk/anthropic' }} />, { wrapper });

    // The mount commit deliberately defers the install; waiting for its affordance proves the initial
    // status check completed, so the blur below is the only remaining commit opportunity.
    await waitFor(() => expect(deferredInstallButton()).toBeTruthy());

    fireEvent.focus(packageInput());
    fireEvent.blur(packageInput());
    await settle();

    expect(mocks.install).not.toHaveBeenCalled();
    expect(deferredInstallButton()).toBeTruthy();
  });

  test('typing a different package and blurring still installs it', async () => {
    render(<Harness initial={{ kind: ProviderKind.AiSdk, packageName: '@ai-sdk/anthropic' }} />, { wrapper });

    await waitFor(() => expect(deferredInstallButton()).toBeTruthy());

    fireEvent.change(packageInput(), { target: { value: '@ai-sdk/google' } });
    fireEvent.blur(packageInput());

    await waitFor(() =>
      expect(mocks.install).toHaveBeenCalledWith({ packageName: '@ai-sdk/google', confirmed: false }),
    );
  });
});
