import { ProviderKind } from '@aio-proxy/types';
import { describe, expect, rs, test } from '@rstest/core';
import { render, renderHook, screen } from '@testing-library/react';

import { useProviderEditorForm } from '../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../lib/constants';
import { IdentitySection } from './identity-section';

const renderIdentity = (mode: ProviderFormMode, kind: ProviderKind) => {
  const { result } = renderHook(() => useProviderEditorForm({ kind }));
  render(<IdentitySection form={result.current} mode={mode} kind={kind} onKindChange={rs.fn()} status="todo" />);
};

describe('IdentitySection', () => {
  test('offers the kind picker and the Provider ID field when creating a config provider', () => {
    renderIdentity(ProviderFormMode.Create, ProviderKind.Api);

    expect(screen.getByTestId('provider-editor-field-kind')).toBeTruthy();
    expect(screen.getByRole('combobox')).toHaveTextContent(/API/u);
    expect(screen.getByTestId('provider-form-field-id')).toBeTruthy();
  });

  test('omits the Provider ID field for oauth creation because the server assigns it', () => {
    renderIdentity(ProviderFormMode.Create, ProviderKind.OAuth);

    expect(screen.getByTestId('provider-editor-field-kind')).toBeTruthy();
    expect(screen.queryByTestId('provider-form-field-id')).toBeNull();
  });

  test('hides the kind picker and the Provider ID field when editing', () => {
    renderIdentity(ProviderFormMode.Edit, ProviderKind.Api);

    expect(screen.queryByTestId('provider-editor-field-kind')).toBeNull();
    expect(screen.queryByTestId('provider-form-field-id')).toBeNull();
    expect(screen.getByTestId('provider-form-field-name')).toBeTruthy();
  });
});
