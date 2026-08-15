import { m } from '@aio-proxy/i18n';
import type {
  DashboardOAuthCapability,
  DashboardOAuthProviderEdit,
  DashboardOAuthSession,
  OAuthProvider,
} from '@aio-proxy/types';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { Toaster } from '@aio-proxy/ui/components/toast';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ProviderFormMode } from '../../lib/constants';
import { ProviderEditorPage } from './provider-editor-page';

const capability: DashboardOAuthCapability = {
  plugin: '@example/oauth',
  capability: 'default',
  displayName: 'Example OAuth',
  description: 'Example account',
  defaults: {},
  form: [
    { type: 'text', key: 'tenant', label: 'Tenant' },
    { type: 'secret', key: 'token', label: 'Token', configured: false },
  ],
};

const oauth: DashboardOAuthProviderEdit = {
  accountLabel: 'Example',
  publicValues: { tenant: 'work' },
  form: capability.form,
  models: ['m1'],
};

const oauthProvider = {
  kind: ProviderKind.OAuth,
  id: 'existing',
  enabled: true,
  plugin: '@example/oauth',
  capability: 'default',
} as OAuthProvider;

const mocks = rs.hoisted(() => ({
  start: rs.fn(),
  create: rs.fn(),
  update: rs.fn(),
  delete: rs.fn(),
  navigate: rs.fn(),
  invalidate: rs.fn(),
  refetch: rs.fn(async () => ({ data: { trusted: true, state: 'bundled' }, error: null })),
  session: undefined as DashboardOAuthSession | undefined,
  sessionError: false,
}));

rs.mock('@tanstack/react-query', () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: (options: { queryKey: readonly string[] }) => {
    let data: unknown;
    if (options.queryKey[0] === 'oauth-capabilities') data = { capabilities: [capability] };
    else if (options.queryKey[0] === 'oauth-session' && mocks.session !== undefined) data = { session: mocks.session };
    else if (options.queryKey[0] === 'providers' && options.queryKey.length === 1) data = { providers: [] };
    return {
      data,
      isError: options.queryKey[0] === 'oauth-session' && mocks.sessionError,
      isLoading: false,
      refetch: mocks.refetch,
    };
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useMutation: () => ({ mutate: mocks.start, isPending: false }),
}));

rs.mock('@tanstack/react-router', () => ({
  Link: ({ children }: React.PropsWithChildren) => <button type="button">{children}</button>,
  useNavigate: () => mocks.navigate,
}));

rs.mock('@/components/json-editor', () => {
  const { useEffect } = require('react') as typeof import('react');
  return {
    // Echoes the schema prop back, like the real editor: its validation results carry the identity of
    // the schema they validated, and the options editor compares those identities before enabling Save.
    JsonEditor: (props: { schema?: object; onValidationChange?: (validation: object) => void }) => {
      useEffect(() => {
        props.onValidationChange?.({
          valid: true,
          syntaxValid: true,
          pending: false,
          markers: [],
          schema: props.schema,
        });
      }, [props.onValidationChange, props.schema]);
      return <textarea data-testid="json-editor" />;
    },
  };
});

rs.mock('../../hooks/use-provider-mutations', () => ({
  useProviderCreate: () => ({
    mutate: (body: unknown, options?: { onSuccess?: () => void }) => {
      mocks.create(body, options);
      options?.onSuccess?.();
    },
    isPending: false,
  }),
  useProviderUpdate: () => ({
    mutate: (input: unknown, options?: { onSuccess?: () => void }) => {
      mocks.update(input, options);
      options?.onSuccess?.();
    },
    isPending: false,
  }),
  useProviderDelete: () => ({ mutate: mocks.delete, isPending: false }),
}));

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: IntersectionObserverStub,
});

afterEach(() => {
  rs.restoreAllMocks();
  mocks.start.mockReset();
  mocks.create.mockReset();
  mocks.update.mockReset();
  mocks.delete.mockReset();
  mocks.navigate.mockReset();
  mocks.invalidate.mockReset();
  mocks.refetch.mockReset();
  mocks.session = undefined;
  mocks.sessionError = false;
});

const renderPage = (props: React.ComponentProps<typeof ProviderEditorPage>) =>
  render(
    <>
      <Toaster />
      <ProviderEditorPage {...props} />
    </>,
  );

const fillName = (name: string) => {
  const input = within(screen.getByTestId('provider-form-field-name')).getByRole('textbox');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.blur(input);
};

const fillId = (id: string) => {
  fireEvent.change(within(screen.getByTestId('provider-form-field-id')).getByRole('textbox'), {
    target: { value: id },
  });
};

const fillBaseURL = (value: string) => {
  fireEvent.change(within(screen.getByTestId('provider-form-field-baseURL')).getByRole('textbox'), {
    target: { value },
  });
};

const pickProtocol = async () => {
  fireEvent.click(within(screen.getByTestId('provider-form-field-protocol')).getByRole('combobox'));
  fireEvent.keyDown(await screen.findByRole('option', { name: 'OpenAI Compatible' }), { key: 'Enter' });
};

const saveButton = () => screen.getByRole('button', { name: /Save/u });
// Scoped to the footer: the connection section now carries its own "Authorize in browser" button,
// so an unscoped /Authorize/ query matches two elements and throws.
const authorizeButton = () => within(screen.getByTestId('editor-footer')).getByRole('button', { name: /Authorize/u });
const packageInput = () => within(screen.getByTestId('provider-form-field-packageName')).getByRole('combobox');

const selectOAuthCapability = async () => {
  const picker = screen.getByRole('combobox', { name: /OAuth provider|OAuth 提供商/u });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.change(picker, { target: { value: 'Example' } });
  fireEvent.click(await screen.findByRole('option', { name: /Example OAuth/u }));
};

test('create-api save stays on the page and shows the saved indicator', async () => {
  const onSessionIdChange = rs.fn();
  renderPage({
    mode: ProviderFormMode.Create,
    kind: ProviderKind.Api,
    initial: { enabled: true, models: ['gpt-5-mini'] },
    onSessionIdChange,
  });

  fillName('Demo API');
  fillId('demo-api');
  fillBaseURL('https://api.example.com/v1');
  await pickProtocol();

  expect(saveButton()).toBeEnabled();
  fireEvent.click(saveButton());

  await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(screen.getByText(/Saved/u)).toBeTruthy();
});

test('create-api emptying baseURL disables save and marks Connection as to do', async () => {
  renderPage({
    mode: ProviderFormMode.Create,
    kind: ProviderKind.Api,
    initial: { enabled: true, models: ['gpt-5-mini'] },
    onSessionIdChange: rs.fn(),
  });

  fillName('Demo API');
  fillId('demo-api');
  fillBaseURL('https://api.example.com/v1');
  await pickProtocol();
  expect(saveButton()).toBeEnabled();

  fillBaseURL('');

  await waitFor(() => expect(saveButton()).toBeDisabled());
  expect(within(screen.getByTestId('editor-footer')).getByRole('button', { name: /Connection/u })).toBeTruthy();
  expect(
    within(screen.getByRole('region', { name: /Connection/u })).getByText(
      m['dashboard.providers.editor.hint_connection_todo_api'](),
    ),
  ).toBeTruthy();
});

test('create-api a malformed baseURL keeps Save enabled and surfaces the parse error', async () => {
  renderPage({
    mode: ProviderFormMode.Create,
    kind: ProviderKind.Api,
    initial: { enabled: true, models: ['gpt-5-mini'] },
    onSessionIdChange: rs.fn(),
  });

  fillName('Demo API');
  fillId('demo-api');
  fillBaseURL('https://api.example.com/v1');
  await pickProtocol();
  fillBaseURL('api.example.com/v1');

  expect(saveButton()).toBeEnabled();
  fireEvent.click(saveButton());

  await waitFor(() => expect(screen.getByText(/Failed to create provider/u)).toBeTruthy());
  expect(mocks.create).not.toHaveBeenCalled();
});

test('create kind switched after typing persists ai-sdk and strips api fields', async () => {
  const onKindChange = rs.fn();
  const props = {
    mode: ProviderFormMode.Create,
    kind: ProviderKind.Api,
    initial: { enabled: true, models: ['gpt-5-mini'] } as const,
    onKindChange,
    onSessionIdChange: rs.fn(),
  };
  const view = renderPage(props);

  fillName('Switched');
  fillId('switched');
  fillBaseURL('https://api.example.com/v1');

  fireEvent.click(screen.getByRole('radio', { name: /AI SDK/u }));
  expect(onKindChange).toHaveBeenCalledWith(ProviderKind.AiSdk);

  view.rerender(
    <>
      <Toaster />
      <ProviderEditorPage {...props} kind={ProviderKind.AiSdk} />
    </>,
  );

  const packageName = packageInput();
  fireEvent.change(packageName, { target: { value: '@example/custom-sdk' } });
  fireEvent.blur(packageName);

  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());

  await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  const body = mocks.create.mock.calls[0]?.[0] as Record<string, unknown>;
  expect(body.kind).toBe('ai-sdk');
  expect(body).not.toHaveProperty('baseURL');
  expect(body).not.toHaveProperty('protocol');
});

test('ai-sdk create lists the common packages and commits the one picked', async () => {
  renderPage({
    mode: ProviderFormMode.Create,
    kind: ProviderKind.AiSdk,
    initial: { enabled: true, models: ['gpt-5-mini'] },
    onSessionIdChange: rs.fn(),
  });

  fillName('SDK Demo');
  fillId('sdk-demo');
  fireEvent.keyDown(packageInput(), { key: 'ArrowDown' });

  const options = await screen.findAllByRole('option');
  expect(options.map((option) => option.textContent)).toEqual([
    '@ai-sdk/openai',
    '@ai-sdk/openai-compatible',
    '@ai-sdk/anthropic',
    '@ai-sdk/google',
    '@ai-sdk/azure',
  ]);

  fireEvent.click(screen.getByRole('option', { name: '@ai-sdk/anthropic' }));

  // No blur is fired here on purpose: picking from the list has to commit the package to the
  // options-schema workflow by itself, or Save stays disabled on an invalid options editor.
  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());

  await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({ packageName: '@ai-sdk/anthropic' });
});

test('ai-sdk create offers a typed package outside the list and commits it', async () => {
  renderPage({
    mode: ProviderFormMode.Create,
    kind: ProviderKind.AiSdk,
    initial: { enabled: true, models: ['gpt-5-mini'] },
    onSessionIdChange: rs.fn(),
  });

  fillName('SDK Demo');
  fillId('sdk-demo');
  const input = packageInput();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.change(input, { target: { value: '@example/custom-sdk' } });

  fireEvent.click(await screen.findByRole('option', { name: /@example\/custom-sdk/u }));

  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());

  await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({ packageName: '@example/custom-sdk' });
});

test('oauth create authorizes from the connection section once a sign-in method is picked', async () => {
  renderPage({
    mode: ProviderFormMode.Create,
    kind: ProviderKind.OAuth,
    initial: { enabled: true },
    onSessionIdChange: rs.fn(),
  });

  const inlineAuthorize = screen.getByTestId('connection-authorize');
  expect(inlineAuthorize).toBeDisabled();
  expect(screen.getByText(m['dashboard.providers.oauth.authorize_popup_hint']())).toBeTruthy();

  fillName('OAuth Demo');
  await selectOAuthCapability();

  await waitFor(() => expect(inlineAuthorize).toBeEnabled());
  fireEvent.click(inlineAuthorize);

  await waitFor(() => expect(mocks.start).toHaveBeenCalled());
  expect(mocks.start.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ providerPatch: expect.objectContaining({ enabled: true, name: 'OAuth Demo' }) }),
  );
});

test('oauth create authorizes in place, locks sections 3-5, then unlocks after success', async () => {
  const onSessionIdChange = rs.fn();
  const props = {
    mode: ProviderFormMode.Create,
    kind: ProviderKind.OAuth,
    initial: { enabled: true } as const,
    onSessionIdChange,
  };
  const view = renderPage(props);

  fillName('OAuth Demo');
  await selectOAuthCapability();

  expect(screen.queryByTestId('provider-form-field-id')).toBeNull();
  expect(screen.getByText(/Authorize this account to unlock/u)).toBeTruthy();
  expect(within(screen.getByRole('region', { name: /Models/u })).getByTestId('models-manual-add-input')).toBeDisabled();
  expect(authorizeButton()).toBeEnabled();

  fireEvent.click(authorizeButton());
  await waitFor(() => expect(mocks.start).toHaveBeenCalled());
  expect(mocks.start.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({
      providerPatch: expect.objectContaining({ enabled: true, name: 'OAuth Demo' }),
    }),
  );

  mocks.session = {
    id: '0198bfc4-239e-7d62-bcb0-a9e0849cabaf',
    status: 'succeeded',
    providerId: 'p-new',
    warning: 'catalog_unavailable',
  };
  view.rerender(
    <>
      <Toaster />
      <ProviderEditorPage {...props} sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" />
    </>,
  );

  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/providers/$id/edit',
      params: { id: 'p-new' },
      search: { session: '0198bfc4-239e-7d62-bcb0-a9e0849cabaf' },
      replace: true,
    }),
  );
  expect(mocks.navigate).not.toHaveBeenCalledWith(expect.objectContaining({ to: '/providers' }));
  expect(screen.getByText(/model catalog is not available/u)).toBeTruthy();
  expect(saveButton()).toBeEnabled();
  expect(within(screen.getByRole('region', { name: /Models/u })).getByTestId('models-manual-add-input')).toBeEnabled();
});

test('oauth empty whitelist lists discovered catalog ids on the exposure rail', () => {
  renderPage({
    mode: ProviderFormMode.Edit,
    kind: ProviderKind.OAuth,
    providerId: 'existing',
    provider: oauthProvider,
    oauth: { ...oauth, models: ['catalog-a', 'catalog-b'] },
    initial: { id: 'existing', enabled: true, models: [] },
    onSessionIdChange: rs.fn(),
  });

  const rail = screen.getByTestId('exposure-panel');
  expect(within(rail).getByTestId('exposure-route-catalog-a')).toBeTruthy();
  expect(within(rail).getByTestId('exposure-route-catalog-b')).toBeTruthy();
  expect(within(rail).queryByText(/Enable models or add aliases/u)).toBeNull();
});

test('edit-mode succeeded session with catalog_unavailable shows the rail warning', async () => {
  mocks.session = {
    id: 'session',
    status: 'succeeded',
    providerId: 'existing',
    warning: 'catalog_unavailable',
  };

  renderPage({
    mode: ProviderFormMode.Edit,
    kind: ProviderKind.OAuth,
    providerId: 'existing',
    provider: oauthProvider,
    oauth,
    initial: { id: 'existing', enabled: true, models: [] },
    sessionId: 'session',
    onSessionIdChange: rs.fn(),
  });

  await waitFor(() =>
    expect(within(screen.getByTestId('exposure-panel')).getByText(/model catalog is not available/u)).toBeTruthy(),
  );
  expect(mocks.navigate).not.toHaveBeenCalled();
});

test('oauth re-auth on an existing provider stays put and refetches the edit view', async () => {
  mocks.session = {
    id: 'session',
    status: 'succeeded',
    providerId: 'existing',
    warning: 'catalog_unavailable',
  };

  renderPage({
    mode: ProviderFormMode.Edit,
    kind: ProviderKind.OAuth,
    providerId: 'existing',
    provider: oauthProvider,
    oauth,
    initial: { id: 'existing', enabled: true, models: [] },
    sessionId: 'session',
    onSessionIdChange: rs.fn(),
  });

  await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
  expect(mocks.navigate).not.toHaveBeenCalledWith(expect.objectContaining({ to: '/providers' }));
  expect(mocks.create).not.toHaveBeenCalled();
});

test('edit mode heads the page with the provider name, and falls back when it has none', () => {
  const props = {
    mode: ProviderFormMode.Edit,
    kind: ProviderKind.Api,
    providerId: 'p1',
    initial: { id: 'p1', name: 'Prod OpenAI', enabled: true, models: ['gpt-5-mini'] } as const,
    onSessionIdChange: rs.fn(),
  };
  const named = renderPage(props);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Prod OpenAI');
  named.unmount();

  // A display name is optional (D-F5), so a historical provider without one still needs a heading.
  renderPage({ ...props, initial: { id: 'p1', enabled: true, models: ['gpt-5-mini'] } });
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(m['dashboard.providers.edit_title']());
});

test('create mode explains what the page is for under the title', () => {
  renderPage({
    mode: ProviderFormMode.Create,
    kind: ProviderKind.Api,
    initial: { enabled: true, models: ['gpt-5-mini'] },
    onSessionIdChange: rs.fn(),
  });

  expect(screen.getByText(m['dashboard.providers.editor.header_create_subtitle']())).toBeTruthy();
});

test('edit-api clearing model metadata sends an explicit empty metadata object', async () => {
  renderPage({
    mode: ProviderFormMode.Edit,
    kind: ProviderKind.Api,
    providerId: 'p1',
    initial: {
      id: 'p1',
      name: 'Existing',
      enabled: true,
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: 'https://api.example.com/v1',
      models: ['a'],
      metadata: { a: { name: 'A' } },
    },
    onSessionIdChange: rs.fn(),
  });

  fireEvent.click(within(screen.getByTestId('model-row-a')).getByTestId('model-row-metadata'));
  await screen.findByTestId('provider-model-metadata-drawer');
  fireEvent.change(within(screen.getByTestId('provider-model-metadata-drawer')).getByRole('textbox'), {
    target: { value: '{}' },
  });
  fireEvent.click(screen.getByTestId('provider-model-metadata-save'));

  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());

  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  expect(mocks.create).not.toHaveBeenCalled();
  const input = mocks.update.mock.calls[0]?.[0] as { body: { metadata?: unknown } };
  expect(input.body.metadata).toEqual({});
});
