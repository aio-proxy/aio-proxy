import { m } from '@aio-proxy/i18n';
import type {
  DashboardOAuthCapability,
  DashboardOAuthProviderEdit,
  DashboardOAuthSession,
  OAuthProvider,
} from '@aio-proxy/types';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { Toaster, toast } from '@aio-proxy/ui/components/toast';
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

// The success toasts are the real hooks' own `onSuccess` (`use-provider-mutations.ts`), kept here
// because they are the only post-success render the page has: the toast is what tells a test that the
// success path has finished committing.
//
// The order of the two statements inside each `mutate` is load-bearing: `onSuccess` must run before
// `toast.add`, so that awaiting the toast proves the post-success re-render already happened. The
// "no permanent Saved line" regression pin below anchors on the toast for exactly that reason —
// swap these two lines and the pin still passes against code that re-adds the line.
rs.mock('../../hooks/use-provider-mutations', () => ({
  useProviderCreate: () => ({
    mutate: (body: unknown, options?: { onSuccess?: () => void }) => {
      mocks.create(body, options);
      options?.onSuccess?.();
      toast.add({ type: 'success', title: m['dashboard.providers.toast.created']() });
    },
    isPending: false,
  }),
  useProviderUpdate: () => ({
    mutate: (input: unknown, options?: { onSuccess?: () => void }) => {
      mocks.update(input, options);
      options?.onSuccess?.();
      toast.add({ type: 'success', title: m['dashboard.providers.toast.updated']() });
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
// Scoped to the footer: "Save provider" is the footer primary in every mode, and an unscoped query
// would also reach the section-level buttons.
const footerPrimary = () => within(screen.getByTestId('editor-footer')).getByRole('button', { name: /Save provider/u });
// The one that actually starts the round trip since X9 gated the footer primary on `attention`.
const sectionAuthorizeButton = () => screen.getByTestId('connection-authorize');
const packageInput = () => within(screen.getByTestId('provider-form-field-packageName')).getByRole('combobox');
// The manual-add box is the shared tags control, which owns no test id; its label is the handle.
const manualAddLabel = m['dashboard.providers.editor.models_manual_add']();

const selectOAuthCapability = async () => {
  const picker = screen.getByRole('combobox', { name: m['dashboard.providers.oauth.select_label']() });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.change(picker, { target: { value: 'Example' } });
  fireEvent.click(await screen.findByRole('option', { name: /Example OAuth/u }));
};

// The removed `footer_saved` copy, in all five locales. Fully anchored: the page's own "Ready to
// save." / "Save provider" and the zh success toasts all contain 保存/儲存 as a substring, and a loose
// matcher would go green on those instead of on the line under test.
const SAVED_LINE = /^(Saved|保存しました|저장됨|已保存|已儲存)$/u;

// The success confirmation is the mutation hook's transient toast; the page keeps no "Saved" line of
// its own, which used to sit there permanently while the footer went back to blocking the next save.
test('create-api save stays on the page', async () => {
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
  // Ordered after the toast, never after `mocks.create` alone: the line only ever rendered once the
  // mutation had succeeded, so an absence assertion that runs before the success render passes against
  // the reverted code too — a false green that would make this pin worthless.
  await screen.findByText(m['dashboard.providers.toast.created']());
  expect(screen.queryByText(SAVED_LINE)).toBeNull();
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
  expect(within(screen.getByTestId('editor-footer')).getByRole('link', { name: /Connection/u })).toBeTruthy();
  expect(
    within(screen.getByRole('region', { name: /Connection/u })).getByText(
      m['dashboard.providers.editor.hint_connection_todo_api'](),
    ),
  ).toBeTruthy();
});

// Was "keeps Save enabled and surfaces the parse error": the mutation body parses `baseURL` with
// `z.url()`, so the bounce this used to pin was a green dot, an enabled Save and a rejected save. The
// section gate is the form's only validator, so it is what has to catch it.
test('create-api a malformed baseURL blocks Save instead of bouncing off the schema', async () => {
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

  await waitFor(() => expect(saveButton()).toBeDisabled());
  expect(within(screen.getByTestId('editor-footer')).getByRole('link', { name: /Connection/u })).toBeTruthy();
  // The malformed-address hint, not the generic one: the badge is the whole explanation, and telling
  // someone who typed an address that they need an address explains nothing.
  expect(
    within(screen.getByRole('region', { name: /Connection/u })).getByText(
      m['dashboard.providers.editor.hint_connection_bad_base_url'](),
    ),
  ).toBeTruthy();
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

  // The id field stays in place for oauth creation, disabled: the authorization flow assigns the id.
  expect(within(screen.getByTestId('provider-form-field-id')).getByRole('textbox')).toBeDisabled();
  expect(screen.getByText(/Authorize this account to unlock/u)).toBeTruthy();
  expect(within(screen.getByRole('region', { name: /Models/u })).getByLabelText(manualAddLabel)).toBeDisabled();
  // X9: an unauthorized oauth draft has nothing to persist, so it is `attention` and the footer primary
  // is gated. The Connection section's own authorize button is the entry that works — the same shape the
  // prototype has, where Save is likewise disabled until the round trip lands. The footer never renames
  // itself to "Authorize": a permanently disabled button must not name the action it cannot perform.
  expect(sectionAuthorizeButton()).toBeEnabled();
  expect(footerPrimary()).toBeDisabled();

  fireEvent.click(sectionAuthorizeButton());
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
  expect(within(screen.getByRole('region', { name: /Models/u })).getByLabelText(manualAddLabel)).toBeEnabled();
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

// A provider with no API key is a legitimate configuration: X9 made the draft saveable, and C15 (ruled
// 2026-08-19) took away the badge text that called the blank field out, so the badge stays on the address.
test('an api create with no key is saveable and its badge shows the address', async () => {
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

  const footer = within(screen.getByTestId('editor-footer'));
  await waitFor(() => expect(footer.getByText(m['dashboard.providers.editor.footer_ready']())).toBeTruthy());
  expect(saveButton()).toBeEnabled();
  expect(within(screen.getByRole('region', { name: /Connection/u })).getByText('api.example.com/v1')).toBeTruthy();
});

test('a form with nothing outstanding announces that it is ready to save', () => {
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
      models: ['gpt-5-mini'],
    },
    onSessionIdChange: rs.fn(),
  });

  const status = within(screen.getByTestId('editor-footer')).getByText(m['dashboard.providers.editor.footer_ready']());
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(saveButton()).toBeEnabled();
});

// The record-keyed editor used to reject a colliding keystroke, leave the box showing the typed
// name, and keep the stored row on the last accepted prefix — so aliasEditorIssues was empty and
// Save stayed enabled over a name the user never confirmed. Writing the name into the row is what
// makes the issue visible to the save gate.
test('typing a name another alias already uses blocks Save', () => {
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
      models: ['model-a', 'model-b'],
      alias: {
        mini: { model: 'model-a', preserve: false },
        fast: { model: 'model-b', preserve: false },
      },
    },
    onSessionIdChange: rs.fn(),
  });

  expect(saveButton()).toBeEnabled();
  const boxes = screen.getAllByLabelText(m['dashboard.providers.form.alias_name']());
  fireEvent.change(boxes[1]!, { target: { value: 'mini' } });

  expect(boxes[0]).toHaveAttribute('aria-invalid', 'true');
  expect(boxes[1]).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('alert')).toHaveTextContent(m['dashboard.providers.form.alias_name_duplicate']());
  expect(saveButton()).toBeDisabled();
});

test('every exposure row names its origin, direct models included', () => {
  renderPage({
    mode: ProviderFormMode.Edit,
    kind: ProviderKind.Api,
    providerId: 'p1',
    initial: {
      id: 'p1',
      enabled: true,
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: 'https://api.example.com/v1',
      models: ['direct-a', 'direct-b'],
      alias: { friendly: { model: 'direct-b', preserve: false } },
    },
    onSessionIdChange: rs.fn(),
  });

  const rail = within(screen.getByTestId('exposure-panel'));
  // `direct-a` exposes its own upstream id, so `alias !== modelId` leaves it unlabelled.
  const direct = within(rail.getByTestId('exposure-route-direct-a'));
  expect(direct.getByText(m['dashboard.providers.editor.exposure_origin_model']())).toBeTruthy();
  expect(direct.queryByText(m['dashboard.providers.editor.exposure_origin_alias']())).toBeNull();

  const mapped = within(rail.getByTestId('exposure-route-friendly'));
  expect(mapped.getByText(m['dashboard.providers.editor.exposure_origin_alias']())).toBeTruthy();
  expect(mapped.getByText(/direct-b/u)).toBeTruthy();
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
  // The drawer opens on the visual form, so emptying the record means going to the raw draft first.
  fireEvent.click(screen.getByTestId('metadata-tab-json'));
  fireEvent.change(await screen.findByTestId('metadata-json-draft'), { target: { value: '{}' } });
  fireEvent.click(screen.getByTestId('provider-model-metadata-save'));

  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());

  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  expect(mocks.create).not.toHaveBeenCalled();
  const input = mocks.update.mock.calls[0]?.[0] as { body: { metadata?: unknown } };
  // Explicitly `{}`, never omitted: `replaceProvider` retains the persisted `metadata` when the body
  // leaves it out, so omission here would make clearing a record impossible.
  expect(input.body.metadata).toEqual({});
});

// The reconciliation that prunes an emptied record ran on the update branch only, so this exact
// sequence wrote `metadata: { a: {} }` into a brand-new provider's config: a key that means nothing,
// for a model whose overrides the user just deleted.
test('create-api prunes an emptied metadata record instead of writing it', async () => {
  renderPage({
    mode: ProviderFormMode.Create,
    kind: ProviderKind.Api,
    initial: { enabled: true, models: ['a'] },
    onSessionIdChange: rs.fn(),
  });

  fillName('Demo API');
  fillId('demo-api');
  fillBaseURL('https://api.example.com/v1');
  await pickProtocol();

  fireEvent.click(within(screen.getByTestId('model-row-a')).getByTestId('model-row-metadata'));
  await screen.findByTestId('provider-model-metadata-drawer');
  fireEvent.change(await screen.findByLabelText('cost.input'), { target: { value: '1' } });
  fireEvent.click(screen.getByTestId('provider-model-metadata-save'));

  // Reopen and clear it again: the record is now `{}`, which is what the update branch drops.
  fireEvent.click(within(screen.getByTestId('model-row-a')).getByTestId('model-row-metadata'));
  await screen.findByTestId('provider-model-metadata-drawer');
  fireEvent.change(await screen.findByLabelText('cost.input'), { target: { value: '' } });
  fireEvent.click(screen.getByTestId('provider-model-metadata-save'));

  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());

  await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  const body = mocks.create.mock.calls[0]?.[0] as { metadata?: unknown };
  // Not `{}` either: nothing was ever persisted, so there is nothing to clear and the key has no
  // reason to exist in the file.
  expect(body.metadata).toBeUndefined();
});

// A provider that has never had per-model overrides got `metadata: {}` written into its config entry
// on every single save, because the body always carried the key.
test('edit-api a provider with no metadata does not gain a dead metadata key', async () => {
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
    },
    onSessionIdChange: rs.fn(),
  });

  fillName('Renamed');
  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());

  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  const input = mocks.update.mock.calls[0]?.[0] as { body: { metadata?: unknown } };
  expect(input.body.metadata).toBeUndefined();
});
