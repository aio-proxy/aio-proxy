import { m } from '@aio-proxy/i18n';
import type { ProviderTransforms } from '@aio-proxy/types';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import {
  type ProviderEditorForm,
  type ProviderEditorShape,
  useProviderEditorForm,
} from '../../../hooks/use-provider-editor-form';
import { AdvancedSection } from './advanced-section';

// The transforms editor mounts Monaco behind its JSON tab, which reaches for a CDN loader happy-dom
// refuses to run. Stubbed to a textarea, as the request-transforms tests do.
rs.mock('@monaco-editor/react', () => ({
  Editor: ({ options, value }: { readonly options?: { readonly ariaLabel?: string }; readonly value?: string }) => (
    <textarea aria-label={options?.ariaLabel} value={value} readOnly />
  ),
}));

rs.mock('@/components/json-editor/json-schema-registry', () => ({
  registerJsonSchema: () => () => undefined,
  validateJsonModel: async () => [],
}));

let section: ProviderEditorForm;

interface HarnessProps {
  readonly kind?: ProviderKind;
  readonly initial?: Partial<ProviderEditorShape>;
}

const Harness: React.FC<HarnessProps> = ({ kind = ProviderKind.Api, initial = {} }) => {
  const form = useProviderEditorForm({
    kind,
    initial: {
      kind,
      id: 'provider',
      protocol: ProviderProtocol.OpenAICompatible,
      ...initial,
    } as Partial<ProviderEditorShape>,
  });
  section = form;
  return (
    <AdvancedSection
      form={form}
      kind={kind}
      summary={{ status: 'ok', hint: '' }}
      onTransformsValidityChange={() => undefined}
    />
  );
};

const rule = { name: 'primary', update: [{ $set: { 'request.body.stream': { $literal: false } } }] };

const headers = () => section.state.values.headers as Readonly<Record<string, string>> | undefined;
const transforms = () => section.state.values.transforms as ProviderTransforms | undefined;
const removeHeader = (key: string) =>
  screen.getByRole('button', { name: m['dashboard.providers.form.remove_header']({ key }) });
const removeRule = (index: number) =>
  screen.getByRole('button', { name: m['dashboard.providers.transforms.rule.remove']({ index }) });
const openPanel = (name: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
const NETWORK = m['dashboard.providers.editor.advanced_group_network']();
const TRANSFORMS = m['dashboard.providers.editor.advanced_group_transforms']();

describe('AdvancedSection', () => {
  // Custom headers are an api-only concept: an ai-sdk provider's requests are built by its package and
  // an oauth provider's by its plugin, so neither has a header map to edit.
  test('an api provider gets the headers field', () => {
    render(<Harness kind={ProviderKind.Api} />);
    openPanel(NETWORK);

    expect(screen.getByTestId('provider-form-field-headers')).toBeInTheDocument();
  });

  test('an ai-sdk provider gets no headers field', () => {
    render(<Harness kind={ProviderKind.AiSdk} />);
    openPanel(NETWORK);

    expect(screen.queryByTestId('provider-form-field-headers')).toBeNull();
  });

  test('proxy and transforms are offered even for the kind that has no headers', () => {
    render(<Harness kind={ProviderKind.OAuth} />);
    openPanel(NETWORK);

    expect(screen.queryByTestId('provider-form-field-headers')).toBeNull();
    expect(screen.getByTestId('provider-form-field-proxy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(TRANSFORMS) })).toBeInTheDocument();
  });

  // Deleting the LAST header is the case the parked task-12 retention item warned about: the save path
  // omits an `undefined` field from the mutation body, and `replaceProvider` retains what the body
  // omits. A `headers` that collapsed to `undefined` on the final delete would leave the removed
  // headers persisted upstream while the editor showed none. An empty map is what actually clears them.
  test('deleting the last header leaves an empty map, not an absent field', () => {
    render(<Harness initial={{ headers: { 'x-only': 'value' } }} />);
    openPanel(NETWORK);

    fireEvent.click(removeHeader('x-only'));

    expect(headers()).toEqual({});
  });

  test('deleting one of two headers keeps the other', () => {
    render(<Harness initial={{ headers: { 'x-keep': 'a', 'x-drop': 'b' } }} />);
    openPanel(NETWORK);

    fireEvent.click(removeHeader('x-drop'));

    expect(headers()).toEqual({ 'x-keep': 'a' });
  });

  // The same retention trap on the other field: `{ request: [] }` clears the persisted rules, whereas
  // an absent `transforms` would silently keep them.
  test('deleting the last transform rule leaves an empty request list, not an absent field', () => {
    render(<Harness initial={{ transforms: { request: [rule] } }} />);
    openPanel(TRANSFORMS);

    fireEvent.click(removeRule(1));

    expect(transforms()).toEqual({ request: [] });
  });

  test('deleting one of two transform rules keeps the other', () => {
    render(<Harness initial={{ transforms: { request: [rule, { ...rule, name: 'secondary' }] } }} />);
    openPanel(TRANSFORMS);

    fireEvent.click(removeRule(1));

    expect(transforms()?.request).toHaveLength(1);
    expect(transforms()?.request?.[0]?.name).toBe('secondary');
  });

  test('a collapsed network trigger reads the proxy mode and header count', () => {
    render(<Harness initial={{ headers: { a: '1', b: '2' } }} />);

    const trigger = screen.getByRole('button', { name: new RegExp(NETWORK) });
    expect(trigger).toHaveTextContent(m['dashboard.providers.form.proxy_inherit']());
    expect(trigger).toHaveTextContent(m['dashboard.providers.editor.hint_advanced_headers']({ count: 2 }));
  });

  test('a collapsed transforms trigger reads whether rules are enabled', () => {
    const { unmount } = render(<Harness />);

    expect(screen.getByRole('button', { name: new RegExp(TRANSFORMS) })).toHaveTextContent(
      m['dashboard.providers.editor.advanced_transforms_none'](),
    );
    unmount();

    render(<Harness initial={{ transforms: { request: [rule] } }} />);

    expect(screen.getByRole('button', { name: new RegExp(TRANSFORMS) })).toHaveTextContent(
      m['dashboard.providers.editor.advanced_transforms_rule']({ count: 1 }),
    );
  });
});
