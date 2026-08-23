import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { type ProviderEditorForm, useProviderEditorForm } from '../../hooks/use-provider-editor-form';
import { ProviderProxyField } from './provider-proxy-field';

let form: ProviderEditorForm;

interface HarnessProps {
  readonly proxy: null | false | string;
}

const Harness: React.FC<HarnessProps> = ({ proxy }) => {
  const editor = useProviderEditorForm({
    kind: ProviderKind.Api,
    initial: {
      kind: ProviderKind.Api,
      id: 'provider',
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: 'https://api.example/v1',
      proxy,
    },
  });
  form = editor;
  return <editor.Field name="proxy">{(field) => <ProviderProxyField field={field} />}</editor.Field>;
};

const pickMode = async (name: RegExp) => {
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.keyDown(await screen.findByRole('option', { name }), { key: 'Enter' });
};

describe('ProviderProxyField', () => {
  test('selecting inherit writes null', async () => {
    render(<Harness proxy={false} />);

    await pickMode(/Inherit global proxy|继承全局代理/u);

    expect(form.state.values.proxy).toBeNull();
  });

  test('selecting disabled writes false', async () => {
    render(<Harness proxy={null} />);

    await pickMode(/Disable proxy|禁用代理/u);

    expect(form.state.values.proxy).toBe(false);
  });

  test('selecting url writes an empty string, not null', async () => {
    render(<Harness proxy={null} />);

    await pickMode(/Use a specific proxy|使用指定代理/u);

    expect(form.state.values.proxy).toBe('');
  });
});
