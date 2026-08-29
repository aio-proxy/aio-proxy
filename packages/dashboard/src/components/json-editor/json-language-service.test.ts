import { CompletionContext } from '@codemirror/autocomplete';
import { json } from '@codemirror/lang-json';
import { forceLinting } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, rs, test } from '@rstest/core';
import { waitFor } from '@testing-library/react';
import { textDocument } from 'codemirror-languageservice';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-json-languageservice';

import {
  configureJsonSchemas,
  createJsonCompletionSource,
  createJsonHoverTooltipSource,
  createJsonLanguageExtensions,
  toJsonValidationMarkers,
} from './json-language-service';

const optionsUri = 'inmemory://aio-proxy/json-editor/options.json';
const optionsSchema = {
  type: 'object',
  properties: {
    baseURL: { type: 'string' },
    apiKey: { type: 'string' },
    headers: { type: 'object' },
  },
} as const;

const visibleCompletionLabels = async (text: string, pos: number) => {
  configureJsonSchemas([
    {
      uri: `${optionsUri}#schema`,
      fileMatch: [optionsUri],
      schema: optionsSchema,
    },
  ]);

  const result = await createJsonCompletionSource()(
    new CompletionContext(
      EditorState.create({
        doc: text,
        extensions: [json(), textDocument(optionsUri)],
      }),
      pos,
      false,
    ),
  );
  if (!result) return [];

  // CodeMirror filters with sliceDoc(from, to), not the cursor.
  const prefix = text.slice(result.from, result.to ?? pos).toLowerCase();
  return result.options.map((option) => option.label).filter((label) => label.toLowerCase().startsWith(prefix));
};

describe('json language service', () => {
  test('keeps only error and warning diagnostics', () => {
    const diagnostics = [
      { severity: DiagnosticSeverity.Error },
      { severity: DiagnosticSeverity.Warning },
      { severity: DiagnosticSeverity.Information },
      { severity: DiagnosticSeverity.Hint },
      {},
    ] as Diagnostic[];

    expect(toJsonValidationMarkers(diagnostics)).toEqual([{ severity: 'error' }, { severity: 'warning' }]);
  });

  test('reports the diagnostics produced by the editor linter', async () => {
    configureJsonSchemas([
      {
        uri: 'schema:required-name',
        fileMatch: ['inmemory://aio-proxy/json-editor/lint-callback.json'],
        schema: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      },
    ]);
    const onValidation = rs.fn();
    const view = new EditorView({
      doc: '{}',
      extensions: [
        json(),
        ...createJsonLanguageExtensions(
          'inmemory://aio-proxy/json-editor/lint-callback.json',
          { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
          onValidation,
        ),
      ],
    });

    forceLinting(view);
    await waitFor(() => expect(onValidation).toHaveBeenCalledWith('{}', [{ severity: 'error' }]));
    view.destroy();
  });

  test('suggests every schema key after an opening quote', async () => {
    await expect(visibleCompletionLabels('{\n  "', 5)).resolves.toEqual(['baseURL', 'apiKey', 'headers']);
  });

  test('suggests schema keys between paired quotes', async () => {
    await expect(visibleCompletionLabels('{\n  ""\n}', 5)).resolves.toEqual(['baseURL', 'apiKey', 'headers']);
  });

  test('keeps baseURL visible after a quoted b prefix', async () => {
    await expect(visibleCompletionLabels('{\n  "b', 6)).resolves.toEqual(['baseURL']);
  });

  test('keeps baseURL visible after a quoted b prefix between paired quotes', async () => {
    await expect(visibleCompletionLabels('{\n  "b"\n}', 6)).resolves.toEqual(['baseURL']);
  });

  test('suggests schema keys after a bare letter', async () => {
    await expect(visibleCompletionLabels('{\n  b', 5)).resolves.toEqual(['baseURL']);
  });

  test('does not suggest schema keys after an opening brace is paired', async () => {
    await expect(visibleCompletionLabels('{}', 1)).resolves.toEqual([]);
  });

  test('suggests enum values from a registered models.dev $ref', async () => {
    const documentUri = 'inmemory://aio-proxy/json-editor/metadata.json';
    const modelsDevUri = 'https://models.dev/model-schema.json';
    configureJsonSchemas([
      {
        uri: `${documentUri}#schema`,
        fileMatch: [documentUri],
        schema: {
          type: 'object',
          properties: {
            extend: { $ref: `${modelsDevUri}#/$defs/Model` },
          },
        },
      },
      {
        uri: modelsDevUri,
        fileMatch: [],
        schema: {
          $id: modelsDevUri,
          $defs: { Model: { type: 'string', enum: ['openai/gpt-5', 'anthropic/claude-sonnet-4'] } },
        },
      },
    ]);

    const text = '{\n  "extend": "\n}';
    const result = await createJsonCompletionSource()(
      new CompletionContext(
        EditorState.create({
          doc: text,
          extensions: [json(), textDocument(documentUri)],
        }),
        15,
        false,
      ),
    );
    const labels = result?.options.map((option) => option.label) ?? [];
    expect(labels).toEqual(expect.arrayContaining(['"openai/gpt-5"', '"anthropic/claude-sonnet-4"']));
  });

  test('renders schema description markdown in hover', async () => {
    configureJsonSchemas([
      {
        uri: `${optionsUri}#schema`,
        fileMatch: [optionsUri],
        schema: {
          type: 'object',
          properties: {
            apiKey: {
              type: 'string',
              description: 'Adds an `Authorization` header.',
            },
          },
        },
      },
    ]);

    const view = new EditorView({
      doc: '{\n  "apiKey": ""\n}',
      extensions: [json(), textDocument(optionsUri)],
    });
    const tooltip = await createJsonHoverTooltipSource()(view, 5, 0);
    const dom = tooltip?.create(view).dom;
    view.destroy();

    expect(dom?.querySelector('code')?.textContent).toBe('Authorization');
    expect(dom?.textContent).not.toContain('`Authorization`');
  });
});
