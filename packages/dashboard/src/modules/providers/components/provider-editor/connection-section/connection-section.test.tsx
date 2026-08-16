import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthCapability, DashboardOAuthProviderEdit, OAuthProvider } from '@aio-proxy/types';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { useOAuthProviderForm } from '../../../hooks/use-oauth-provider-form';
import { type ProviderEditorShape, useProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../../lib/constants';
import { capabilityKey } from '../../../lib/oauth-capability-key';
import { ConnectionSection } from './connection-section';

// Only the ai-sdk arm's service boundary is stubbed. `@tanstack/react-query` stays real: a stubbed
// `useQuery` would let the package field mount regardless of the kind guard above it.
rs.mock('../../../services/provider-options-schema-service', () => ({
  providerPackageStatusQueryOptions: (packageName: string) => ({
    queryKey: ['provider-package-status', packageName],
    queryFn: () => ({ installed: false }),
  }),
  installProviderPackage: rs.fn(),
}));

// The ai-sdk options editor mounts Monaco, which reaches for a CDN loader happy-dom refuses to run.
// Stubbed to a textarea, as the request-transforms tests do — this section asserts nothing about it.
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

const capability: DashboardOAuthCapability = {
  plugin: '@aio-proxy/plugin-acme',
  capability: 'login',
  displayName: 'Acme Login',
  form: [{ key: 'tenant', label: 'Tenant', type: 'text' }],
  defaults: {},
};

const oauthEdit: DashboardOAuthProviderEdit = {
  accountLabel: 'acme@example.com',
  publicValues: {},
  form: [{ key: 'tenant', label: 'Tenant', type: 'text' }],
  models: [],
};

const oauthProvider = {
  kind: ProviderKind.OAuth,
  plugin: '@aio-proxy/plugin-acme',
  capability: 'login',
} as OAuthProvider;

const initialFor = (kind: ProviderKind): Partial<ProviderEditorShape> =>
  kind === ProviderKind.Api
    ? { kind, id: 'provider', protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://api.example/v1' }
    : ({ kind, id: 'provider' } as Partial<ProviderEditorShape>);

interface HarnessProps {
  readonly kind: ProviderKind;
  readonly mode?: ProviderFormMode;
  /** OAuth create only, and only once a capability is picked: what enables the authorize button. */
  readonly pickedCapability?: boolean;
  readonly isAuthorizationPending?: boolean;
  /** Edit mode with one of the two required oauth props withheld, to pin each half of that guard. */
  readonly withhold?: 'oauth' | 'provider';
}

const Harness: React.FC<HarnessProps> = ({
  kind,
  mode = ProviderFormMode.Create,
  pickedCapability = false,
  isAuthorizationPending = false,
  withhold,
}) => {
  const form = useProviderEditorForm({ kind, initial: initialFor(kind) });
  const accountForm = useOAuthProviderForm(
    () => undefined,
    pickedCapability ? { capabilityKey: capabilityKey(capability) } : {},
  );
  const isEdit = mode === ProviderFormMode.Edit;
  return (
    <ConnectionSection
      form={form}
      accountForm={accountForm}
      mode={mode}
      kind={kind}
      capabilities={[capability]}
      oauth={isEdit && withhold !== 'oauth' ? oauthEdit : undefined}
      provider={isEdit && withhold !== 'provider' ? oauthProvider : undefined}
      onReauthorize={() => undefined}
      isAuthorizationPending={isAuthorizationPending}
      onAuthorize={() => undefined}
      summary={{ status: 'todo', hint: '' }}
    />
  );
};

const renderConnection = (props: HarnessProps) => render(<Harness {...props} />, { wrapper });

// One stable marker per delegate, so "did the right arm mount" never depends on shared copy.
const apiFields = () => screen.queryByTestId('provider-form-field-baseURL');
const aiSdkFields = () => screen.queryByTestId('provider-form-field-packageName');
const oauthCreateFields = () => screen.queryByTestId('connection-authorize');
const oauthEditFields = () => screen.queryByRole('button', { name: m['dashboard.providers.oauth.reauthorize']() });

beforeEach(() => {
  queryClient.clear();
});

describe('ConnectionSection', () => {
  // The kind switch is four sibling ternaries over the same children, so the mutant that matters is a
  // dropped guard rather than a wrong one: each case asserts the other three arms are absent, which is
  // what fails if any `kind === ...` or `mode === ...` condition is removed.
  test('an api provider gets the api fields and nothing from the other three arms', () => {
    renderConnection({ kind: ProviderKind.Api });

    expect(apiFields()).toBeInTheDocument();
    expect(aiSdkFields()).toBeNull();
    expect(oauthCreateFields()).toBeNull();
    expect(oauthEditFields()).toBeNull();
  });

  test('an ai-sdk provider gets the package fields and nothing from the other three arms', () => {
    renderConnection({ kind: ProviderKind.AiSdk });

    expect(aiSdkFields()).toBeInTheDocument();
    expect(apiFields()).toBeNull();
    expect(oauthCreateFields()).toBeNull();
    expect(oauthEditFields()).toBeNull();
  });

  test('oauth creation gets the capability picker and authorize button, not the edit panel', () => {
    renderConnection({ kind: ProviderKind.OAuth });

    expect(oauthCreateFields()).toBeInTheDocument();
    expect(screen.getByLabelText(m['dashboard.providers.oauth.select_label']())).toBeInTheDocument();
    expect(oauthEditFields()).toBeNull();
    expect(apiFields()).toBeNull();
    expect(aiSdkFields()).toBeNull();
  });

  // Minor 15's pattern at the editor's other combobox: the visible <Label htmlFor="oauth-capability">
  // is correctly associated with the input's id, so an aria-label carrying the same string only
  // replaces that name with a copy of itself. Should either string later change alone, a speech-input
  // user could no longer address the field by the words on screen.
  test('the capability picker takes its name from the visible label, with no aria-label shadowing it', () => {
    renderConnection({ kind: ProviderKind.OAuth });

    const input = screen.getByRole('combobox', { name: m['dashboard.providers.oauth.select_label']() });
    expect(input).not.toHaveAttribute('aria-label');
  });

  test('oauth editing gets the account panel and reauthorize, not the create-time picker', () => {
    renderConnection({ kind: ProviderKind.OAuth, mode: ProviderFormMode.Edit });

    expect(oauthEditFields()).toBeInTheDocument();
    expect(screen.getByText(oauthEdit.accountLabel)).toBeInTheDocument();
    expect(oauthCreateFields()).toBeNull();
    expect(apiFields()).toBeNull();
    expect(aiSdkFields()).toBeNull();
  });

  // `oauth` and `provider` are separately optional props, and the edit arm needs both because
  // OAuthProviderEditFields dereferences `provider.plugin` and `oauth.accountLabel` unguarded. The
  // edit route happens to send them together or not at all, so neither of these is reachable today —
  // but each half of the guard is what keeps a caller that diverges from crashing the whole editor
  // instead of rendering nothing, and dropping either half is a one-token mutant.
  test('oauth editing renders nothing when the provider record is missing', () => {
    renderConnection({ kind: ProviderKind.OAuth, mode: ProviderFormMode.Edit, withhold: 'provider' });

    expect(oauthEditFields()).toBeNull();
    expect(oauthCreateFields()).toBeNull();
  });

  test('oauth editing renders nothing when the oauth payload is missing', () => {
    renderConnection({ kind: ProviderKind.OAuth, mode: ProviderFormMode.Edit, withhold: 'oauth' });

    expect(oauthEditFields()).toBeNull();
    expect(oauthCreateFields()).toBeNull();
  });

  // The authorize button opens a popup and posts the account fields. Left live while a start is in
  // flight, a second click starts a second session against the same draft; the pending flag is the
  // only thing standing between the two.
  test('an in-flight authorization disables the authorize button and shows its spinner', () => {
    renderConnection({ kind: ProviderKind.OAuth, pickedCapability: true, isAuthorizationPending: true });

    const authorize = screen.getByTestId('connection-authorize');
    expect(authorize).toBeDisabled();
    expect(authorize.querySelector('[data-icon="inline-start"]')).not.toBeNull();
  });

  test('a picked capability with nothing in flight leaves authorize clickable and unspun', () => {
    renderConnection({ kind: ProviderKind.OAuth, pickedCapability: true });

    const authorize = screen.getByTestId('connection-authorize');
    expect(authorize).toBeEnabled();
    expect(authorize.querySelector('[data-icon="inline-start"]')).toBeNull();
  });

  // The other half of the same `disabled`: an empty capabilityKey has no capability to authorize
  // against, so the button must be dead before the combobox is touched.
  test('authorize stays disabled until a capability is picked', () => {
    renderConnection({ kind: ProviderKind.OAuth });

    expect(screen.getByTestId('connection-authorize')).toBeDisabled();
  });

  // Edit mode routes the same pending flag through `isReauthorizing`, and its `?? false` default made
  // it easy to hardcode. A reauthorize is a full OAuth round trip against a live provider.
  test('an in-flight reauthorization disables the reauthorize button', () => {
    renderConnection({ kind: ProviderKind.OAuth, mode: ProviderFormMode.Edit, isAuthorizationPending: true });

    expect(screen.getByRole('button', { name: m['dashboard.providers.oauth.reauthorize']() })).toBeDisabled();
  });

  test('reauthorize is live when nothing is in flight', () => {
    renderConnection({ kind: ProviderKind.OAuth, mode: ProviderFormMode.Edit });

    expect(screen.getByRole('button', { name: m['dashboard.providers.oauth.reauthorize']() })).toBeEnabled();
  });
});
