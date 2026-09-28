import { m } from '@aio-proxy/i18n';
import type { ModelMetadataInput } from '@aio-proxy/types';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { queries } from '@testing-library/dom';
import { fireEvent, render, screen, waitFor, within, type BoundFunctions } from '@testing-library/react';
import { useState, type ReactNode } from 'react';

import { ModelMetadataEditor } from './model-metadata-editor';

const mocks = rs.hoisted(() => ({
  slugs: rs.fn(),
  lookup: rs.fn(),
  registerJsonSchema: rs.fn(() => () => undefined),
}));

rs.mock('@/components/json-editor/json-schema-registry', () => ({
  registerJsonSchema: mocks.registerJsonSchema,
}));

rs.mock('@/components/json-editor/json-language-service', () => ({
  createJsonLanguageExtensions: () => [],
}));

// CodeMirror is not exercised in tests, so the stand-in mirrors `readOnly` onto the textarea it
// renders. That keeps the prop's journey from ModelMetadataEditor down to the editor observable;
// CodeEditor itself turns it into EditorState.readOnly / EditorView.editable.
rs.mock('@/components/code-editor', () => ({
  CodeEditor: ({
    id,
    onChange,
    value,
    invalid,
    readOnly,
  }: {
    id?: string;
    onChange?: (next: string) => void;
    value: string;
    invalid?: boolean;
    readOnly?: boolean;
  }) => (
    <textarea
      id={id}
      value={value}
      readOnly={readOnly}
      aria-invalid={invalid ? 'true' : undefined}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

rs.mock('../../services/models-dev-service', () => ({
  modelsDevSlugsQueryOptions: () => ({ queryKey: ['models-dev-slugs'], queryFn: mocks.slugs }),
  modelsDevLookupQueryOptions: (id: string) => ({
    queryKey: ['models-dev-lookup', id],
    queryFn: () => mocks.lookup(id),
  }),
}));

const queryClient = new QueryClient({
  defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
});
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

// The value the controlled editor last handed its owner — what a save body would carry.
let emitted: ModelMetadataInput | undefined;

const Harness: React.FC<{
  readonly initial?: ModelMetadataInput | undefined;
  readonly readOnly?: boolean;
}> = ({ initial, readOnly = false }) => {
  const [value, setValue] = useState(initial);
  emitted = value;
  return <ModelMetadataEditor model="model-a" value={value} onChange={setValue} readOnly={readOnly} />;
};

const renderEditor = (initial?: ModelMetadataInput, options: { readonly readOnly?: boolean } = {}) =>
  render(<Harness initial={initial} readOnly={options.readOnly ?? false} />, { wrapper });

const jsonDraftField = async (scope: Pick<BoundFunctions<typeof queries>, 'findByTestId'> = screen) => {
  const host = await scope.findByTestId('metadata-json-draft');
  if (host instanceof HTMLTextAreaElement) return host;
  const textarea = host.querySelector('textarea');
  if (textarea === null) throw new Error('metadata json draft is missing a textarea');
  return textarea;
};

const limitContextLabel = () => m['dashboard.routing.editor.metadata_limit_label_context']();
const limitInputLabel = () => m['dashboard.routing.editor.metadata_limit_label_input']();
const costInputLabel = () => m['dashboard.routing.editor.metadata_cost_label_input']();
const costCacheReadLabel = () => m['dashboard.routing.editor.metadata_cost_label_cache_read']();
const costReasoningLabel = () => m['dashboard.routing.editor.metadata_cost_label_reasoning']();
const nameLabel = () => m['dashboard.routing.editor.metadata_field_label_name']();
/** A field's override switch, once the reference it would seed from has loaded. */
const overrideSwitch = async (label: string) => {
  const control = await screen.findByRole('switch', {
    name: m['dashboard.routing.profile.override_field']({ field: label }),
  });
  await waitFor(() => expect(control).toBeEnabled());
  return control;
};
/** Turns a field's override on and returns its input; a field that follows the reference has none. */
const overrideField = async (label: string) => {
  fireEvent.click(await overrideSwitch(label));
  return screen.getByLabelText(label);
};
/** The segment of a capability's follow / supported / unsupported control. */
const capabilityChoice = async (capability: string, name: string) =>
  within(await screen.findByTestId(`metadata-capability-${capability}`)).getByRole('button', { name });
/** What a field that follows the reference shows: the reference value in a disabled input. */
const followedValue = (id: string) => document.getElementById(id);

beforeEach(() => {
  emitted = undefined;
  mocks.slugs.mockReset();
  mocks.slugs.mockResolvedValue({ slugs: ['openai/gpt-5', 'anthropic/claude-opus-4'] });
  mocks.lookup.mockReset();
  mocks.lookup.mockResolvedValue({ slug: null, metadata: null });
  mocks.registerJsonSchema.mockClear();
  queryClient.clear();
});

describe('ModelMetadataEditor', () => {
  test('the visual tab merges over fields it cannot edit instead of replacing them', async () => {
    renderEditor({ capabilities: { knowledge: '2024-06' }, limit: { context: 100 } });

    fireEvent.change(await screen.findByLabelText(limitContextLabel()), { target: { value: '4096' } });

    await waitFor(() =>
      expect(emitted).toEqual({
        capabilities: { knowledge: '2024-06' },
        limit: { context: 4096 },
      }),
    );
  });

  test('a fractional cost typed one keystroke at a time survives, and clearing it deletes the key', async () => {
    renderEditor();

    const cost = (await overrideField(costInputLabel())) as HTMLInputElement;
    // Append to the live DOM value rather than feeding absolute strings. The regression is React
    // rewriting the field at the `0.0` step, where `Number()` collapses the text to `0`; an absolute
    // next event would overwrite that rewrite, so the test would pass either way. Appending carries
    // the clobber forward — on the broken code the field accumulates to `75`.
    for (const character of '0.075') {
      fireEvent.change(cost, { target: { value: cost.value + character } });
    }

    expect(cost).toHaveValue(0.075);
    await waitFor(() => expect(emitted).toEqual({ cost: { input: 0.075 } }));

    // Clearing a money field must delete the key, not write `0` — and with nothing left, the
    // controlled value goes back to undefined ("cleared"), not `{}`.
    fireEvent.change(cost, { target: { value: '' } });
    await waitFor(() => expect(emitted).toBeUndefined());
  });

  test('the form cannot be re-entered while the JSON draft is unparseable', async () => {
    renderEditor({ name: 'A' });

    // Drop the closing brace: the form merges over the parsed draft, so entering it on broken text
    // would write back an object missing every key the text still carries.
    fireEvent.click(await screen.findByTestId('metadata-tab-json'));
    expect(screen.getByTestId('metadata-tab-visual')).toBeEnabled();
    fireEvent.change(await jsonDraftField(), { target: { value: '{"name":"A"' } });

    await waitFor(() => expect(screen.getByTestId('metadata-tab-visual')).toBeDisabled());
    fireEvent.click(screen.getByTestId('metadata-tab-visual'));
    expect(screen.queryByLabelText(limitContextLabel())).toBeNull();

    // The unparseable text stays local: the owner still holds the last valid value.
    expect(emitted).toEqual({ name: 'A' });

    // Emptying the textarea to start over has no keys to lose, so it must not lock the tab —
    // and it IS a deliberate clear, so the owner now sees undefined.
    fireEvent.change(await jsonDraftField(), { target: { value: '  ' } });
    await waitFor(() => expect(screen.getByTestId('metadata-tab-visual')).toBeEnabled());
    expect(emitted).toBeUndefined();
  });

  // The editor is a form, not a code editor: it opens on the form and only an unparseable draft may
  // force JSON.
  test('opens on the form and an unparseable draft forces JSON until repaired', async () => {
    renderEditor({ name: 'A' });

    // No click needed: the fields are there because the form is the default.
    expect(await overrideSwitch(limitContextLabel())).toBeInTheDocument();
    expect(screen.queryByTestId('metadata-json-draft')).toBeNull();

    fireEvent.click(screen.getByTestId('metadata-tab-json'));
    fireEvent.change(await jsonDraftField(), { target: { value: '{oops' } });
    expect(screen.queryByLabelText(limitContextLabel())).toBeNull();

    // The mode still has to obey the user: repairing the draft and going back must work, or forcing
    // JSON once would strand the user there for the rest of the session.
    fireEvent.change(await jsonDraftField(), { target: { value: '{"name":"A"}' } });
    fireEvent.click(screen.getByTestId('metadata-tab-visual'));
    expect(await overrideSwitch(limitContextLabel())).toBeInTheDocument();
  });

  // A two-state switch reads an explicit `false` as "inherit" and silently converts it on save. Only a
  // three-state control can tell the two apart, so both directions are pinned here.
  test('a capability reads and writes explicit false, and follow deletes the key', async () => {
    renderEditor({ capabilities: { attachment: false, reasoning: true } });

    const unsupported = m['dashboard.routing.editor.metadata_capability_unsupported']();
    const supported = m['dashboard.routing.editor.metadata_capability_supported']();
    expect(await capabilityChoice('attachment', unsupported)).toHaveAttribute('aria-pressed', 'true');
    expect(await capabilityChoice('reasoning', supported)).toHaveAttribute('aria-pressed', 'true');

    // Follow is the only choice that writes nothing.
    fireEvent.click(await capabilityChoice('attachment', m['dashboard.routing.editor.metadata_capability_inherit']()));
    await waitFor(() => expect(emitted).toEqual({ capabilities: { reasoning: true } }));

    // And unsupported writes the boolean rather than dropping the key.
    fireEvent.click(await capabilityChoice('toolCall', unsupported));
    await waitFor(() =>
      expect(emitted).toEqual({
        capabilities: { reasoning: true, toolCall: false },
      }),
    );
  });

  test('the limit, cost, and name fields round-trip into the JSON draft', async () => {
    renderEditor();

    fireEvent.change(await overrideField(limitInputLabel()), { target: { value: '8192' } });
    fireEvent.change(await overrideField(costCacheReadLabel()), { target: { value: '0.5' } });
    fireEvent.change(await overrideField(nameLabel()), { target: { value: 'GPT-5' } });
    // A field left off follows the reference model; with none it reads as unset, never as zero.
    expect(await overrideSwitch(costReasoningLabel())).not.toBeChecked();
    expect(followedValue('metadata-cost-reasoning')).toHaveValue('');
    expect(followedValue('metadata-cost-reasoning')).toHaveAttribute(
      'placeholder',
      m['dashboard.routing.profile.not_set'](),
    );

    // The JSON tab is the same draft seen from the other side; a field wired to nothing shows up here.
    fireEvent.click(screen.getByTestId('metadata-tab-json'));
    const draft = JSON.parse((await jsonDraftField()).value);
    expect(draft).toEqual({ name: 'GPT-5', limit: { input: 8192 }, cost: { cacheRead: 0.5 } });
    expect(emitted).toEqual(draft);
  });

  // An overflowing entry (`1e999` parses to Infinity) is the one numeric string the field cannot
  // store. Keeping its text on screen left the input showing a value the draft did not contain, so
  // the user read a context limit or a price that was never saved.
  test('a number the draft cannot hold is refused instead of being displayed', async () => {
    renderEditor({ limit: { context: 4096 } });

    const context = (await screen.findByLabelText(limitContextLabel())) as HTMLInputElement;
    fireEvent.change(context, { target: { value: '1e999' } });

    expect(context.value).toBe('4096');
    fireEvent.click(screen.getByTestId('metadata-tab-json'));
    const draft = JSON.parse((await jsonDraftField()).value);
    expect(draft).toEqual({ limit: { context: 4096 } });
  });

  // An empty picker with no explanation is indistinguishable from a catalog with no models.
  test('a failed models.dev slug query explains itself and offers a retry', async () => {
    mocks.slugs.mockRejectedValue(new Error('offline'));
    renderEditor();

    const retry = await screen.findByTestId('metadata-extend-retry');
    expect(screen.getByTestId('metadata-extend-status')).toHaveTextContent(
      m['dashboard.routing.editor.metadata_extend_error'](),
    );

    mocks.slugs.mockResolvedValue({ slugs: ['openai/gpt-5'] });
    fireEvent.click(retry);

    // With the catalog back and no match for the model ID, the field says so instead of erroring.
    await waitFor(() =>
      expect(screen.getByTestId('metadata-extend-status')).toHaveTextContent(
        m['dashboard.routing.profile.reference_manual'](),
      ),
    );
  });

  // Without `extend` the saved overrides would name nothing they inherit from, so the first override
  // writes the automatic match; undoing every override takes it back out, leaving no phantom edit.
  test('overriding a field of an automatically matched model writes the match into extend', async () => {
    mocks.lookup.mockResolvedValue({ slug: 'openai/gpt-5', metadata: { name: 'GPT-5' } });
    renderEditor();

    const name = await overrideSwitch(nameLabel());
    fireEvent.click(name);
    await waitFor(() => expect(emitted).toEqual({ extend: 'openai/gpt-5', name: 'GPT-5' }));

    fireEvent.click(name);
    await waitFor(() => expect(emitted).toBeUndefined());
  });

  test('the JSON draft names the reference first', async () => {
    mocks.lookup.mockResolvedValue({ slug: 'openai/gpt-5', metadata: { name: 'GPT-5' } });
    renderEditor();

    fireEvent.click(await overrideSwitch(nameLabel()));
    await waitFor(() => expect(emitted).toEqual({ extend: 'openai/gpt-5', name: 'GPT-5' }));
    fireEvent.click(screen.getByTestId('metadata-tab-json'));
    expect(Object.keys(JSON.parse((await jsonDraftField()).value))).toEqual(['extend', 'name']);
  });

  test('clearing a chosen reference returns to the automatic match', async () => {
    mocks.lookup.mockImplementation(async (id: string) =>
      id === 'model-a'
        ? { slug: 'anthropic/claude-opus-4', metadata: { name: 'Claude Opus 4' } }
        : { slug: id, metadata: { name: 'GPT-5' } },
    );
    renderEditor({ extend: 'openai/gpt-5' });

    await waitFor(() => expect(document.getElementById('metadata-extend')).toHaveValue('openai/gpt-5'));
    expect(screen.queryByTestId('metadata-extend-matched')).toBeNull();
    const clear = document.querySelector('[data-slot="combobox-clear"]');
    if (!(clear instanceof HTMLElement)) throw new Error('a chosen reference has no clear control');
    fireEvent.click(clear);

    await waitFor(() => expect(emitted).toBeUndefined());
    await waitFor(() => expect(document.getElementById('metadata-extend')).toHaveValue('anthropic/claude-opus-4'));
    expect(screen.getByTestId('metadata-extend-matched')).toBeInTheDocument();
    // The match is not a choice, so there is nothing to clear.
    expect(document.querySelector('[data-slot="combobox-clear"]')).toBeNull();
  });

  test('the extend picker is disabled only while the catalog is loading and no slug is set', async () => {
    mocks.slugs.mockReset();
    mocks.slugs.mockImplementation(() => new Promise(() => {}));
    renderEditor();

    const empty = document.getElementById('metadata-extend');
    expect(empty).toBeDisabled();
    expect(empty).toHaveAttribute('placeholder', m['dashboard.routing.editor.metadata_extend_loading_placeholder']());
    expect(empty).toHaveAttribute('aria-label', m['dashboard.routing.editor.metadata_extend_aria_label']());
    expect(screen.getByRole('status')).toHaveTextContent(m['dashboard.routing.editor.metadata_extend_loading']());
  });

  test('the extend picker stays enabled while the catalog is loading if a slug is already set', async () => {
    mocks.slugs.mockReset();
    mocks.slugs.mockImplementation(() => new Promise(() => {}));
    renderEditor({ extend: 'openai/gpt-5' });

    const filled = document.getElementById('metadata-extend');
    expect(filled).toBeEnabled();
    expect(filled).toHaveValue('openai/gpt-5');
  });

  test('an extend slug missing from the catalog stays in the picker so it can be selected again', async () => {
    mocks.slugs.mockResolvedValue({ slugs: ['openai/gpt-5'] });
    renderEditor({ extend: 'legacy/missing-slug' });

    await waitFor(() => expect(document.getElementById('metadata-extend')).toBeEnabled());
    const picker = document.getElementById('metadata-extend')?.closest('[data-slot="input-group"]');
    if (!(picker instanceof HTMLElement)) throw new Error('reference picker is missing');
    fireEvent.mouseDown(within(picker).getByRole('button', { expanded: false }));
    // The typed query is the saved slug itself, so the catalog hit is filtered out; the
    // discriminating check is that the missing slug is still an option and can be picked again.
    expect(await screen.findByRole('option', { name: 'legacy/missing-slug' })).toBeInTheDocument();
  });

  test('visual metadata fields are named by prose, not config key paths', async () => {
    renderEditor();

    expect(await overrideSwitch(limitContextLabel())).toBeInTheDocument();
    expect(await overrideSwitch(nameLabel())).toBeInTheDocument();
    expect(
      screen.getByLabelText(m['dashboard.routing.editor.metadata_capability_label_reasoning']()),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Temperature')).toBeInTheDocument();
    expect(screen.queryByLabelText('limit.context')).toBeNull();
    expect(screen.queryByLabelText('capabilities.reasoning')).toBeNull();
  });

  test('broken JSON and a schema failure use different alerts, and only the former blocks the form', async () => {
    renderEditor({ name: 'A' });

    fireEvent.click(screen.getByTestId('metadata-tab-json'));

    fireEvent.change(await jsonDraftField(), { target: { value: '{oops' } });
    const jsonAlert = await screen.findByRole('alert');
    expect(jsonAlert).toHaveTextContent(m['dashboard.routing.editor.metadata_json_error']());
    expect(jsonAlert).toHaveAttribute('id', 'metadata-visual-blocked');
    expect(screen.getByTestId('metadata-tab-visual')).toBeDisabled();

    // A legal object that Zod rejects is still a form: the way back stays open, and the alert
    // has to name the field instead of claiming the draft is not an object.
    fireEvent.change(await jsonDraftField(), {
      target: { value: JSON.stringify({ limit: { context: 100, input: 200 } }) },
    });
    await waitFor(() => expect(screen.getByTestId('metadata-tab-visual')).toBeEnabled());
    const schemaAlert = screen.getByRole('alert');
    expect(schemaAlert).toHaveTextContent(
      m['dashboard.routing.editor.metadata_schema_error']({
        path: 'limit.input',
      }),
    );
    expect(schemaAlert).not.toHaveAttribute('id', 'metadata-visual-blocked');
    // A schema-invalid draft never reaches the owner; the last valid value stands.
    expect(emitted).toEqual({ name: 'A' });
  });

  // The proxy falls back to the catalog entry matching the model ID, so that match is shown as the
  // reference in effect and its values as the ones followed, without writing `extend`.
  test('a model without a chosen reference follows its automatic match', async () => {
    mocks.lookup.mockResolvedValue({ slug: 'openai/gpt-5', metadata: { name: 'GPT-5', cost: { input: 2 } } });
    renderEditor();

    await waitFor(() => expect(document.getElementById('metadata-extend')).toHaveValue('openai/gpt-5'));
    expect(screen.getByTestId('metadata-extend-matched')).toBeInTheDocument();
    await waitFor(() => expect(followedValue('metadata-name')).toHaveValue('GPT-5'));
    expect(followedValue('metadata-cost-input')).toHaveValue('2');
    expect(emitted).toBeUndefined();
  });

  test('a field that is not overridden shows the reference value, and overriding starts from it', async () => {
    mocks.lookup.mockResolvedValue({
      slug: 'openai/gpt-5',
      metadata: {
        name: 'GPT-5',
        description: 'A capable model.',
        limit: { context: 128_000, input: 120_000, output: 8_000 },
        capabilities: { reasoning: true, temperature: false },
        cost: { input: 2, output: 10 },
      },
    });
    renderEditor({ extend: 'openai/gpt-5' });

    await waitFor(() => expect(followedValue('metadata-name')).toHaveValue('GPT-5'));
    expect(followedValue('metadata-description')).toHaveValue('A capable model.');
    expect(followedValue('metadata-limit-context')).toHaveValue('128K');
    expect(followedValue('metadata-limit-input')).toHaveValue('120K');
    expect(followedValue('metadata-cost-input')).toHaveValue('2');
    // "Follow" is the choice in effect, and it names the value it follows.
    expect(
      await capabilityChoice(
        'reasoning',
        m['dashboard.routing.editor.metadata_capability_inherit_value']({
          value: m['dashboard.routing.editor.metadata_capability_supported'](),
        }),
      ),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      await capabilityChoice(
        'temperature',
        m['dashboard.routing.editor.metadata_capability_inherit_value']({
          value: m['dashboard.routing.editor.metadata_capability_unsupported'](),
        }),
      ),
    ).toHaveAttribute('aria-pressed', 'true');

    // Overriding seeds the reference value, so the user edits what the model reports instead of a blank.
    fireEvent.click(await overrideSwitch(limitContextLabel()));
    await waitFor(() => expect(emitted).toEqual({ extend: 'openai/gpt-5', limit: { context: 128_000 } }));
    expect(screen.getByLabelText(limitContextLabel())).toHaveValue(128_000);
  });

  test('overriding tier prices starts from a copy of the reference tiers', async () => {
    // Tiers replace wholesale when the server merges `extend`, so an override that started empty
    // would silently drop every reference tier the user did not retype.
    const tiers = [{ tier: { type: 'context', size: 200_000 }, input: 6, output: 22.5 }];
    mocks.lookup.mockResolvedValue({ slug: 'openai/gpt-5', metadata: { cost: { input: 3, tiers } } });
    renderEditor({ extend: 'openai/gpt-5' });
    await waitFor(() => expect(followedValue('metadata-cost-input')).toHaveValue('3'));

    fireEvent.click(await overrideSwitch(m['dashboard.routing.profile.tiers']()));

    await waitFor(() => expect(emitted).toEqual({ extend: 'openai/gpt-5', cost: { tiers } }));
    fireEvent.change(screen.getByLabelText(costInputLabel(), { selector: '#metadata-cost-tier-0-input' }), {
      target: { value: '7' },
    });
    await waitFor(() =>
      expect(emitted).toEqual({ extend: 'openai/gpt-5', cost: { tiers: [{ ...tiers[0], input: 7 }] } }),
    );
  });

  test('registers the models.dev Model schema so JSON extend values can autocomplete', async () => {
    renderEditor();

    await waitFor(() => {
      expect(mocks.registerJsonSchema).toHaveBeenCalledWith(
        'https://models.dev/model-schema.json',
        expect.objectContaining({
          uri: 'https://models.dev/model-schema.json',
          schema: {
            $id: 'https://models.dev/model-schema.json',
            $defs: { Model: { type: 'string', enum: ['openai/gpt-5', 'anthropic/claude-opus-4'] } },
          },
        }),
      );
    });
  });
});

test('locks the form and the JSON editor when the owner says the config cannot be written', async () => {
  // A disabled fieldset reaches the visual inputs but never CodeMirror, so the JSON pane needs the
  // prop of its own — otherwise a read-only user can still type a draft nothing can save.
  renderEditor({ limit: { context: 1000 } }, { readOnly: true });

  expect(screen.getByLabelText(limitContextLabel())).toBeDisabled();

  fireEvent.click(screen.getByTestId('metadata-tab-json'));

  expect(await jsonDraftField()).toHaveAttribute('readonly');
});

test('leaves the form and the JSON editor editable when the config is writable', async () => {
  renderEditor({ limit: { context: 1000 } });

  expect(screen.getByLabelText(limitContextLabel())).toBeEnabled();

  fireEvent.click(screen.getByTestId('metadata-tab-json'));

  expect(await jsonDraftField()).not.toHaveAttribute('readonly');
});
