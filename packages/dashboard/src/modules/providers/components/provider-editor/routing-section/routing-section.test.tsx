import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { type ProviderEditorForm, useProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import type { ProviderEditorShape } from '../../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../../lib/constants';
import { RoutingSection } from './routing-section';

let section: ProviderEditorForm;

interface HarnessProps {
  readonly initial: Partial<ProviderEditorShape>;
  readonly models: readonly string[];
  readonly candidates?: readonly string[] | undefined;
  readonly others?: React.ComponentProps<typeof RoutingSection>['others'];
}

const Harness: React.FC<HarnessProps> = ({ initial, models, candidates, others = [] }) => {
  const form = useProviderEditorForm({ kind: ProviderKind.Api, initial });
  section = form;
  return (
    <RoutingSection
      form={form}
      mode={ProviderFormMode.Edit}
      models={models}
      candidates={candidates}
      others={others}
      summary={{ status: 'ok', hint: '' }}
    />
  );
};

const apiInitial = (models: readonly string[], alias?: Record<string, { model: string; preserve: boolean }>) => ({
  kind: ProviderKind.Api,
  id: 'provider',
  protocol: ProviderProtocol.OpenAICompatible,
  baseURL: 'https://api.example/v1',
  models,
  ...(alias === undefined ? {} : { alias }),
});

// Open the draft's target picker and read back the option labels it offers.
const targetOptions = async () => {
  const draft = await screen.findByTestId('provider-alias-draft');
  fireEvent.click(within(draft).getByRole('combobox'));
  const options = await screen.findAllByRole('option');
  return options.map((option) => option.textContent);
};

describe('RoutingSection', () => {
  // Spec change 6 made an alias-only provider (models: []) valid on both server and client. The draft
  // row is the surface that matters: `ProviderAliasConfigFields` only renders for an already-named
  // alias, so a fixture with an existing `alias` entry never mounts the draft and would pass green
  // while the authoring path stays broken.
  test('an empty whitelist offers the discovered catalog as alias targets', async () => {
    render(<Harness initial={apiInitial([])} models={[]} candidates={['disc-a', 'disc-b']} />);

    fireEvent.click(screen.getByRole('button', { name: /Add Alias|添加/u }));

    expect(await targetOptions()).toEqual(['disc-a', 'disc-b']);
  });

  test('a non-empty whitelist offers only the whitelist', async () => {
    render(
      <Harness initial={apiInitial(['model-a'])} models={['model-a']} candidates={['disc-a', 'disc-b', 'model-a']} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Add Alias|添加/u }));

    expect(await targetOptions()).toEqual(['model-a']);
  });

  // The raw whitelist, never the fallback, feeds aliasEditorIssues: empty there correctly means "no
  // whitelist, so no target can be missing". The target here is absent from the catalog on purpose —
  // passing the fallback instead would flag it target-missing and mark the section invalid.
  test('an alias-only provider reports no target-missing issue', () => {
    render(
      <Harness
        initial={apiInitial([], { smart: { model: 'legacy-model', preserve: false } })}
        models={[]}
        candidates={['disc-a']}
      />,
    );

    const card = screen.getByTestId('provider-alias-card');
    expect(within(card).getByLabelText(/Target Model|目标/u)).not.toHaveAttribute('aria-invalid', 'true');
  });

  // Empty-state Add lives in ProviderAliasList, not the secondary button RoutingAliases gates.
  // After the top-level substitution, `models` *is* targetOptions: no catalog means no picker
  // options, so the button must stay disabled; a loaded catalog still authorizes alias-only.
  test('empty-state Add Alias is disabled when target options are empty', () => {
    render(<Harness initial={apiInitial([])} models={[]} />);

    expect(screen.getByRole('button', { name: /Add Alias|添加/u })).toBeDisabled();
  });

  test('empty-state Add Alias is enabled when the catalog fills target options', () => {
    render(<Harness initial={apiInitial([])} models={[]} candidates={['disc-a']} />);

    expect(screen.getByRole('button', { name: /Add Alias|添加/u })).toBeEnabled();
  });

  test('empty whitelist previews attempt order from the discovered catalog', () => {
    render(
      <Harness
        initial={apiInitial([])}
        models={[]}
        candidates={['disc-a']}
        others={[{ id: 'other', clientModels: ['disc-a'], enabled: true }]}
      />,
    );

    expect(screen.getByTestId('attempt-order-row-disc-a')).toBeTruthy();
    expect(screen.queryByTestId('attempt-order-empty')).toBeNull();
  });

  test('the weight slider writes the dragged value onto the form', () => {
    render(<Harness initial={apiInitial(['model-a'])} models={['model-a']} />);

    expect(section.state.values.weight).toBeUndefined();
    // `hidden: true`: the slider thumb is visibility:hidden until it measures the track, and happy-dom
    // has no layout, so the nested range input is outside the accessibility tree.
    fireEvent.change(screen.getByRole('slider', { hidden: true }), { target: { value: '35' } });

    expect(section.state.values.weight).toBe(35);
  });
});
