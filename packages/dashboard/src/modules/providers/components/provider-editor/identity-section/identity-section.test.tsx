import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';

import { useProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../../lib/constants';
import { IdentitySection } from './identity-section';

const renderIdentity = (mode: ProviderFormMode, kind: ProviderKind, initial?: { readonly name?: string }) => {
  const { result } = renderHook(() => useProviderEditorForm({ kind, ...(initial === undefined ? {} : { initial }) }));
  const view = render(
    <IdentitySection form={result.current} mode={mode} kind={kind} summary={{ status: 'todo', hint: '' }} />,
  );
  // Re-renders the same form instance under a different kind, which is what picking another kind card
  // does: the form is owned by the page, not remounted per kind.
  const switchKind = (next: ProviderKind) =>
    view.rerender(
      <IdentitySection form={result.current} mode={mode} kind={next} summary={{ status: 'todo', hint: '' }} />,
    );
  return { switchKind };
};

const nameInput = () => within(screen.getByTestId('provider-form-field-name')).getByRole('textbox');
const idInput = () => within(screen.getByTestId('provider-form-field-id')).getByRole('textbox');

describe('IdentitySection', () => {
  test('shows the Provider ID for oauth creation, frozen and explained, because the server assigns it', () => {
    renderIdentity(ProviderFormMode.Create, ProviderKind.OAuth);

    // The field keeps its place in every mode; what changes is that it cannot be typed into and says why.
    expect(idInput()).toBeDisabled();
    expect(idInput()).toHaveValue('');
    expect(
      within(screen.getByTestId('provider-form-field-id')).getByText(
        m['dashboard.providers.form.id_description_server_assigned'](),
      ),
    ).toBeTruthy();
  });

  test('leaves the id alone while typing a name for oauth creation', async () => {
    renderIdentity(ProviderFormMode.Create, ProviderKind.OAuth);

    fireEvent.change(nameInput(), { target: { value: 'OpenAI 主账号' } });

    await waitFor(() => expect(nameInput()).toHaveValue('OpenAI 主账号'));
    // Deriving one would show the user an id the authorization flow is about to overwrite.
    expect(idInput()).toHaveValue('');
  });

  test('derives the id live while typing the name, and stops once the id is edited by hand', async () => {
    renderIdentity(ProviderFormMode.Create, ProviderKind.Api);

    fireEvent.change(nameInput(), { target: { value: 'OpenAI 主账号' } });
    await waitFor(() => expect(idInput()).toHaveValue('openai'));

    fireEvent.change(idInput(), { target: { value: 'my-own-id' } });
    fireEvent.change(nameInput(), { target: { value: 'OpenAI Backup' } });

    await waitFor(() => expect(nameInput()).toHaveValue('OpenAI Backup'));
    expect(idInput()).toHaveValue('my-own-id');
  });

  test('says the id is auto-derived until the user pins it', async () => {
    renderIdentity(ProviderFormMode.Create, ProviderKind.Api);

    const field = () => screen.getByTestId('provider-form-field-id');
    expect(within(field()).getByText(m['dashboard.providers.form.id_description_auto']())).toBeTruthy();

    fireEvent.change(idInput(), { target: { value: 'pinned' } });

    await waitFor(() =>
      expect(within(field()).getByText(m['dashboard.providers.form.id_description_pinned']())).toBeTruthy(),
    );
    expect(within(field()).queryByText(m['dashboard.providers.form.id_description_auto']())).toBeNull();
  });

  test('drops a derived id from view when the kind switches to oauth, and brings it back on the way out', async () => {
    const { switchKind } = renderIdentity(ProviderFormMode.Create, ProviderKind.Api);

    fireEvent.change(nameInput(), { target: { value: 'OpenAI Main' } });
    await waitFor(() => expect(idInput()).toHaveValue('openai-main'));

    switchKind(ProviderKind.OAuth);

    // Showing `openai-main` under "the authorization flow fills this in" would say two contradictory
    // things at once, and that id is not what the created provider gets.
    await waitFor(() => expect(idInput()).toHaveValue(''));
    expect(idInput()).toBeDisabled();
    expect(
      within(screen.getByTestId('provider-form-field-id')).getByText(
        m['dashboard.providers.form.id_description_server_assigned'](),
      ),
    ).toBeTruthy();

    switchKind(ProviderKind.Api);

    // Hidden, not discarded: a user who mis-clicks oauth keeps the id they had named.
    await waitFor(() => expect(idInput()).toHaveValue('openai-main'));
  });

  test('keeps the id readable but frozen when editing', () => {
    renderIdentity(ProviderFormMode.Edit, ProviderKind.Api, { name: 'Existing' });

    expect(idInput()).toBeDisabled();
    expect(
      within(screen.getByTestId('provider-form-field-id')).getByText(
        m['dashboard.providers.form.id_description_locked'](),
      ),
    ).toBeTruthy();
  });
});
