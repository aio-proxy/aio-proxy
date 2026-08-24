import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { type ProviderEditorForm, useProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import type { ProviderEditorShape } from '../../../hooks/use-provider-editor-form';
import { RoutingSection } from './routing-section';

let section: ProviderEditorForm;

interface HarnessProps {
  readonly initial: Partial<ProviderEditorShape>;
}

const Harness: React.FC<HarnessProps> = ({ initial }) => {
  const form = useProviderEditorForm({ kind: ProviderKind.Api, initial });
  section = form;
  return <RoutingSection form={form} summary={{ status: 'ok', hint: '' }} />;
};

const apiInitial = (models: readonly string[]) => ({
  kind: ProviderKind.Api,
  id: 'provider',
  protocol: ProviderProtocol.OpenAICompatible,
  baseURL: 'https://api.example/v1',
  models,
});

describe('RoutingSection', () => {
  test('the two number fields sit side by side and write onto the form', () => {
    render(<Harness initial={apiInitial(['model-a'])} />);

    fireEvent.change(screen.getByTestId('priority-number-input'), { target: { value: '4' } });
    fireEvent.change(screen.getByTestId('weight-number-input'), { target: { value: '35' } });

    expect(section.state.values.priority).toBe(4);
    expect(section.state.values.weight).toBe(35);
    expect(screen.getByTestId('provider-form-field-priority').parentElement).toHaveClass('sm:grid-cols-2');
  });

  test('clearing a field returns the form to absent rather than zero', () => {
    render(<Harness initial={{ ...apiInitial(['model-a']), priority: 4, weight: 40 }} />);

    fireEvent.change(screen.getByTestId('priority-number-input'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('weight-number-input'), { target: { value: '' } });

    expect(section.state.values.priority).toBeUndefined();
    expect(section.state.values.weight).toBeUndefined();
  });
});
