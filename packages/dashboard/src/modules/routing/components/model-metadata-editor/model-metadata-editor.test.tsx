import { m } from '@aio-proxy/i18n';
import type { ModelMetadataInput } from '@aio-proxy/types';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { queries } from '@testing-library/dom';
import { fireEvent, render, screen, waitFor, type BoundFunctions } from '@testing-library/react';
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

rs.mock('@/components/code-editor', () => ({
  CodeEditor: ({
    id,
    onChange,
    value,
    invalid,
  }: {
    id?: string;
    onChange?: (next: string) => void;
    value: string;
    invalid?: boolean;
  }) => (
    <textarea
      id={id}
      value={value}
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

const Harness: React.FC<{ readonly initial?: ModelMetadataInput | undefined }> = ({ initial }) => {
  const [value, setValue] = useState(initial);
  emitted = value;
  return <ModelMetadataEditor model="model-a" value={value} onChange={setValue} />;
};

const renderEditor = (initial?: ModelMetadataInput) => render(<Harness initial={initial} />, { wrapper });

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

    const cost = (await screen.findByLabelText(costInputLabel())) as HTMLInputElement;
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

  test('the visual tab cannot be entered while the JSON draft is unparseable', async () => {
    renderEditor({ name: 'A' });

    expect(screen.getByTestId('metadata-tab-visual')).not.toHaveAttribute('aria-disabled', 'true');

    // Drop the closing brace: the visual tab merges over the parsed draft, so entering it on broken
    // text would write back an object missing every key the text still carries.
    fireEvent.click(screen.getByTestId('metadata-tab-json'));
    fireEvent.change(await jsonDraftField(), { target: { value: '{"name":"A"' } });

    // Base UI marks a disabled tab with aria-disabled, not the native attribute.
    await waitFor(() => expect(screen.getByTestId('metadata-tab-visual')).toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByTestId('metadata-tab-visual'));
    // keepMounted defaults to false, so the visual fields' absence is the assertion.
    expect(screen.queryByLabelText(limitContextLabel())).toBeNull();

    // The unparseable text stays local: the owner still holds the last valid value.
    expect(emitted).toEqual({ name: 'A' });

    // Emptying the textarea to start over has no keys to lose, so it must not lock the tab —
    // and it IS a deliberate clear, so the owner now sees undefined.
    fireEvent.change(await jsonDraftField(), { target: { value: '  ' } });
    await waitFor(() => expect(screen.getByTestId('metadata-tab-visual')).not.toHaveAttribute('aria-disabled', 'true'));
    expect(emitted).toBeUndefined();
  });

  // The editor is a form, not a code editor: it opens on the visual tab and only an unparseable
  // draft may force JSON.
  test('opens on the visual tab and an unparseable draft forces JSON until repaired', async () => {
    renderEditor({ name: 'A' });

    // No click into the visual tab: the fields are there because visual is the default.
    expect(await screen.findByLabelText(limitContextLabel())).toBeInTheDocument();
    expect(screen.getByTestId('metadata-tab-visual')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('metadata-json-draft')).toBeNull();

    fireEvent.click(screen.getByTestId('metadata-tab-json'));
    fireEvent.change(await jsonDraftField(), { target: { value: '{oops' } });
    await waitFor(() => expect(screen.getByTestId('metadata-tab-json')).toHaveAttribute('aria-selected', 'true'));

    // Controlled tabs still have to obey the user: repairing the draft and choosing visual must work,
    // or forcing json once would strand the user there for the rest of the session.
    fireEvent.change(await jsonDraftField(), { target: { value: '{"name":"A"}' } });
    fireEvent.click(screen.getByTestId('metadata-tab-visual'));
    expect(await screen.findByLabelText(limitContextLabel())).toBeInTheDocument();
  });

  // A two-state switch reads an explicit `false` as "inherit" and silently converts it on save. Only a
  // three-state control can tell the two apart, so both directions are pinned here.
  test('a capability reads and writes explicit false, and inherit deletes the key', async () => {
    renderEditor({ capabilities: { attachment: false, reasoning: true } });

    const attachment = await screen.findByTestId('metadata-capability-attachment');
    expect(attachment).toHaveTextContent(m['dashboard.routing.editor.metadata_capability_unsupported']());
    expect(screen.getByTestId('metadata-capability-reasoning')).toHaveTextContent(
      m['dashboard.routing.editor.metadata_capability_supported'](),
    );

    // Inherit is the only choice that writes nothing.
    fireEvent.click(attachment);
    fireEvent.keyDown(
      await screen.findByRole('option', { name: m['dashboard.routing.editor.metadata_capability_inherit']() }),
      { key: 'Enter' },
    );
    await waitFor(() => expect(emitted).toEqual({ capabilities: { reasoning: true } }));

    // And unsupported writes the boolean rather than dropping the key.
    fireEvent.click(await screen.findByTestId('metadata-capability-toolCall'));
    fireEvent.keyDown(
      await screen.findByRole('option', { name: m['dashboard.routing.editor.metadata_capability_unsupported']() }),
      { key: 'Enter' },
    );
    await waitFor(() =>
      expect(emitted).toEqual({
        capabilities: { reasoning: true, toolCall: false },
      }),
    );
  });

  test('the limit, cost, and name fields round-trip into the JSON draft', async () => {
    renderEditor();

    fireEvent.change(await screen.findByLabelText(limitInputLabel()), { target: { value: '8192' } });
    fireEvent.change(screen.getByLabelText(costCacheReadLabel()), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText(nameLabel()), { target: { value: 'GPT-5' } });
    // An empty number field must read as inherit, not as zero.
    expect(screen.getByLabelText(costReasoningLabel())).toHaveAttribute(
      'placeholder',
      m['dashboard.routing.editor.metadata_inherit_placeholder'](),
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

    await waitFor(() =>
      expect(screen.getByTestId('metadata-extend-status')).toHaveTextContent(
        m['dashboard.routing.editor.metadata_extend_loaded']({ count: 1 }),
      ),
    );
  });

  test('the extend picker keeps a clear control when a slug is set', async () => {
    renderEditor({ extend: 'openai/gpt-5' });

    await screen.findByTestId('metadata-extend-status');
    expect(document.querySelector('[data-slot="combobox-clear"]')).not.toBeNull();
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

    await screen.findByTestId('metadata-extend-status');
    fireEvent.mouseDown(screen.getByRole('button', { expanded: false }));
    // The typed query is the saved slug itself, so the catalog hit is filtered out; the
    // discriminating check is that the missing slug is still an option and can be picked again.
    expect(await screen.findByRole('option', { name: 'legacy/missing-slug' })).toBeInTheDocument();
  });

  test('visual metadata fields are named by prose, not config key paths', async () => {
    renderEditor();

    expect(await screen.findByLabelText(limitContextLabel())).toBeInTheDocument();
    expect(
      screen.getByLabelText(m['dashboard.routing.editor.metadata_capability_label_reasoning']()),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Temperature')).toBeInTheDocument();
    expect(screen.getByLabelText(nameLabel())).toHaveAttribute(
      'placeholder',
      m['dashboard.routing.editor.metadata_name_placeholder'](),
    );
    expect(screen.queryByLabelText('limit.context')).toBeNull();
    expect(screen.queryByLabelText('capabilities.reasoning')).toBeNull();
  });

  test('broken JSON and a schema failure use different alerts, and only the former names the blocked tab', async () => {
    renderEditor({ name: 'A' });

    fireEvent.click(screen.getByTestId('metadata-tab-json'));

    fireEvent.change(await jsonDraftField(), { target: { value: '{oops' } });
    const jsonAlert = await screen.findByRole('alert');
    expect(jsonAlert).toHaveTextContent(m['dashboard.routing.editor.metadata_json_error']());
    expect(jsonAlert).toHaveAttribute('id', 'metadata-visual-blocked');
    expect(screen.getByTestId('metadata-tab-visual')).toHaveAttribute('aria-disabled', 'true');

    // A legal object that Zod rejects is still a form: the visual tab stays open, and the alert
    // has to name the field instead of claiming the draft is not an object.
    fireEvent.change(await jsonDraftField(), {
      target: { value: JSON.stringify({ limit: { context: 100, input: 200 } }) },
    });
    await waitFor(() => expect(screen.getByTestId('metadata-tab-visual')).not.toHaveAttribute('aria-disabled', 'true'));
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

  test('a fallback slug is offered next to the loaded-count status and a click fills extend', async () => {
    mocks.lookup.mockImplementation(async (id: string) =>
      id === 'model-a'
        ? { slug: 'openai/gpt-5', metadata: { name: 'GPT-5' } }
        : { slug: 'openai/gpt-5', metadata: { name: 'GPT-5' } },
    );
    renderEditor();

    const suggest = await screen.findByTestId('metadata-extend-suggest');
    expect(suggest).toHaveTextContent(m['dashboard.routing.editor.metadata_extend_suggest']({ slug: 'openai/gpt-5' }));
    fireEvent.click(suggest);

    await waitFor(() => expect(emitted).toEqual({ extend: 'openai/gpt-5' }));
    expect(screen.queryByTestId('metadata-extend-suggest')).toBeNull();
    expect(document.getElementById('metadata-extend')).toHaveValue('openai/gpt-5');
  });

  test('an extend value replaces inherit placeholders with the catalog fields', async () => {
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

    await waitFor(() => expect(screen.getByLabelText(nameLabel())).toHaveAttribute('placeholder', 'GPT-5'));
    expect(screen.getByLabelText(m['dashboard.routing.editor.metadata_field_label_description']())).toHaveAttribute(
      'placeholder',
      'A capable model.',
    );
    expect(screen.getByLabelText(limitContextLabel())).toHaveAttribute('placeholder', '128000');
    expect(screen.getByLabelText(limitInputLabel())).toHaveAttribute('placeholder', '120000');
    expect(screen.getByLabelText(costInputLabel())).toHaveAttribute('placeholder', '2');
    expect(screen.getByTestId('metadata-capability-reasoning')).toHaveAttribute('data-placeholder');
    expect(screen.getByTestId('metadata-capability-reasoning')).toHaveTextContent(
      m['dashboard.routing.editor.metadata_capability_inherit_value']({
        value: m['dashboard.routing.editor.metadata_capability_supported'](),
      }),
    );
    expect(screen.getByTestId('metadata-capability-temperature')).toHaveAttribute('data-placeholder');
    expect(screen.getByTestId('metadata-capability-temperature')).toHaveTextContent(
      m['dashboard.routing.editor.metadata_capability_inherit_value']({
        value: m['dashboard.routing.editor.metadata_capability_unsupported'](),
      }),
    );
    expect(screen.queryByTestId('metadata-extend-suggest')).toBeNull();
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
