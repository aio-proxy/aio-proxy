import { m } from '@aio-proxy/i18n';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { useProviderEditorForm } from '../../hooks/use-provider-editor-form';
import { ProviderHeadersField } from './provider-headers-field';

interface HarnessProps {
  readonly headers: Readonly<Record<string, string>>;
}

const Harness: React.FC<HarnessProps> = ({ headers }) => {
  const editor = useProviderEditorForm({
    kind: ProviderKind.Api,
    initial: {
      kind: ProviderKind.Api,
      id: 'provider',
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: 'https://api.example/v1',
      headers,
    },
  });
  return (
    <editor.Field name="headers">
      {(field) => (
        <ProviderHeadersField
          value={field.state.value as Readonly<Record<string, string>> | undefined}
          onChange={(next) => field.handleChange(next)}
        />
      )}
    </editor.Field>
  );
};

describe('ProviderHeadersField', () => {
  test('header inputs expose accessible names', () => {
    render(<Harness headers={{ 'x-a': 'b' }} />);

    expect(screen.getByLabelText(m['dashboard.providers.form.label_header_key']())).toHaveValue('x-a');
    expect(screen.getByLabelText(m['dashboard.providers.form.label_header_value']())).toHaveValue('b');
  });

  test('remove button falls back to unnamed when the key is empty', () => {
    render(<Harness headers={{ '': 'v' }} />);

    expect(
      screen.getByRole('button', {
        name: m['dashboard.providers.form.remove_header']({
          key: m['dashboard.providers.form.header_unnamed'](),
        }),
      }),
    ).toBeTruthy();
  });
});
