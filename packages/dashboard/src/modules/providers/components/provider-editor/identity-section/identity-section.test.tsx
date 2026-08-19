import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';

import { useProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../../lib/constants';
import { IdentitySection } from './identity-section';

const renderIdentity = (mode: ProviderFormMode, kind: ProviderKind, initial?: { readonly name?: string }) => {
  const onKindChange = rs.fn();
  const { result } = renderHook(() => useProviderEditorForm({ kind, ...(initial === undefined ? {} : { initial }) }));
  render(
    <IdentitySection
      form={result.current}
      mode={mode}
      kind={kind}
      onKindChange={onKindChange}
      summary={{ status: 'todo', hint: '' }}
    />,
  );
  return onKindChange;
};

const kindCard = (name: RegExp) => screen.getByRole('radio', { name });
const nameInput = () => within(screen.getByTestId('provider-form-field-name')).getByRole('textbox');
const idInput = () => within(screen.getByTestId('provider-form-field-id')).getByRole('textbox');

describe('IdentitySection', () => {
  test('offers all three kind cards with their hints and reports the picked kind', () => {
    const onKindChange = renderIdentity(ProviderFormMode.Create, ProviderKind.Api);

    expect(screen.getByRole('radiogroup')).toBeTruthy();
    expect(kindCard(/API/u)).toHaveAttribute('aria-checked', 'true');
    expect(kindCard(/OAuth/u)).toHaveAttribute('aria-checked', 'false');
    expect(kindCard(/AI SDK/u)).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(m['dashboard.providers.editor.kind_api_hint']())).toBeTruthy();
    expect(screen.getByText(m['dashboard.providers.editor.kind_oauth_hint']())).toBeTruthy();
    expect(screen.getByText(m['dashboard.providers.editor.kind_ai_sdk_hint']())).toBeTruthy();

    fireEvent.click(kindCard(/AI SDK/u));

    expect(onKindChange).toHaveBeenCalledWith(ProviderKind.AiSdk);
  });

  test('walks the cards with either arrow axis, wraps at the ends, and keeps one tab stop', () => {
    const onKindChange = renderIdentity(ProviderFormMode.Create, ProviderKind.Api);
    const group = screen.getByRole('radiogroup');

    // Roving tabindex: Tab enters the group at the selected card, not at all three.
    expect(kindCard(/API/u)).toHaveAttribute('tabindex', '0');
    expect(kindCard(/OAuth/u)).toHaveAttribute('tabindex', '-1');
    expect(kindCard(/AI SDK/u)).toHaveAttribute('tabindex', '-1');

    // `false` means the handler called preventDefault, so arrows do not also scroll the page.
    expect(fireEvent.keyDown(group, { key: 'ArrowRight' })).toBe(false);
    expect(onKindChange).toHaveBeenLastCalledWith(ProviderKind.OAuth);
    expect(document.activeElement).toBe(kindCard(/OAuth/u));

    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(onKindChange).toHaveBeenLastCalledWith(ProviderKind.OAuth);

    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onKindChange).toHaveBeenLastCalledWith(ProviderKind.AiSdk);

    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(onKindChange).toHaveBeenLastCalledWith(ProviderKind.AiSdk);

    fireEvent.keyDown(group, { key: 'a' });
    expect(onKindChange).toHaveBeenCalledTimes(4);
  });

  test('states the locked kind instead of a picker when editing', () => {
    renderIdentity(ProviderFormMode.Edit, ProviderKind.AiSdk);

    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByTestId('provider-editor-kind-locked')).toHaveTextContent(
      m['dashboard.providers.editor.kind_ai_sdk'](),
    );
    expect(screen.getByText(m['dashboard.providers.editor.kind_locked_note']())).toBeTruthy();
  });

  test('omits the Provider ID field for oauth creation because the server assigns it', () => {
    renderIdentity(ProviderFormMode.Create, ProviderKind.OAuth);

    expect(screen.getByRole('radiogroup')).toBeTruthy();
    expect(screen.queryByTestId('provider-form-field-id')).toBeNull();
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
