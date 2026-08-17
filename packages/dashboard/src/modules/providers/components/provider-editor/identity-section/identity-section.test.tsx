import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';

import { useProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../../lib/constants';
import { IdentitySection } from './identity-section';

const renderIdentity = (mode: ProviderFormMode, kind: ProviderKind, initial?: { readonly name?: string }) => {
  const { result } = renderHook(() => useProviderEditorForm({ kind, ...(initial === undefined ? {} : { initial }) }));
  render(<IdentitySection form={result.current} mode={mode} kind={kind} summary={{ status: 'todo', hint: '' }} />);
};

const nameInput = () => within(screen.getByTestId('provider-form-field-name')).getByRole('textbox');
const idInput = () => within(screen.getByTestId('provider-form-field-id')).getByRole('textbox');

describe('IdentitySection', () => {
  test('omits the Provider ID field for oauth creation because the server assigns it', () => {
    renderIdentity(ProviderFormMode.Create, ProviderKind.OAuth);

    expect(screen.queryByTestId('provider-form-field-id')).toBeNull();
    expect(screen.getByTestId('provider-form-field-name')).toBeTruthy();
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
