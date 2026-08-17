import { autocompletion, type CompletionSource } from '@codemirror/autocomplete';
import { linter } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { hoverTooltip } from '@codemirror/view';
import {
  createCompletionSource,
  createHoverTooltipSource,
  createLintSource,
  textDocument,
} from 'codemirror-languageservice';
import {
  ClientCapabilities,
  DiagnosticSeverity,
  getLanguageService,
  type Diagnostic,
  type JSONSchema,
} from 'vscode-json-languageservice';

import type { JsonSchema, JsonValidationMarker } from './json-editor-state';
import { markdownToDom } from './json-markup';
import { withMarkdownDescriptions } from './json-schema-markdown';

type JsonSchemaRegistration = {
  readonly uri: string;
  readonly fileMatch: readonly string[];
  readonly schema: JsonSchema;
};

const documentSettings = {
  comments: 'error',
  trailingCommas: 'error',
  schemaValidation: 'error',
} as const;

const languageService = getLanguageService({ clientCapabilities: ClientCapabilities.LATEST });

export const toJsonValidationMarkers = (diagnostics: readonly Diagnostic[]): readonly JsonValidationMarker[] =>
  diagnostics.flatMap((diagnostic): readonly JsonValidationMarker[] => {
    if (diagnostic.severity === DiagnosticSeverity.Error) return [{ severity: 'error' }];
    if (diagnostic.severity === DiagnosticSeverity.Warning) return [{ severity: 'warning' }];
    return [];
  });

export const configureJsonSchemas = (schemas: readonly JsonSchemaRegistration[]) => {
  languageService.configure({
    validate: true,
    allowComments: false,
    schemas: schemas.map(({ fileMatch, schema, ...registration }) => ({
      ...registration,
      fileMatch: [...fileMatch],
      schema: withMarkdownDescriptions(schema),
    })),
  });
};

export const createJsonCompletionSource = (): CompletionSource => {
  const source = createCompletionSource({
    markdownToDom,
    triggerCharacters: '": \n\t,',
    doComplete: (document, position) =>
      languageService.doComplete(document, position, languageService.parseJSONDocument(document)),
  });

  return async (context) => {
    const result = await source(context);
    if (!result) return null;

    // The language service's textEdit covers the quoted key, including a
    // closeBrackets pair. CodeMirror filters with sliceDoc(from, to), so keep
    // that range on the typed prefix inside the quotes.
    const typed = context.state.sliceDoc(result.from, context.pos);
    return typed.startsWith('"') ? { ...result, from: result.from + 1, to: context.pos } : result;
  };
};

export const createJsonHoverTooltipSource = () => {
  return createHoverTooltipSource({
    markdownToDom,
    doHover: (document, position) =>
      languageService.doHover(document, position, languageService.parseJSONDocument(document)),
  });
};

export const createJsonLanguageExtensions = (
  uri: string,
  schema: JsonSchema | undefined,
  onValidation: (draft: string, markers: readonly JsonValidationMarker[]) => void,
): Extension[] => [
  textDocument(uri),
  autocompletion({
    icons: false,
    override: [createJsonCompletionSource()],
  }),
  hoverTooltip(createJsonHoverTooltipSource()),
  linter(
    createLintSource({
      doDiagnostics: async (document) => {
        const diagnostics = await languageService.doValidation(
          document,
          languageService.parseJSONDocument(document),
          documentSettings,
          schema as JSONSchema | undefined,
        );
        onValidation(document.getText(), toJsonValidationMarkers(diagnostics));
        return diagnostics;
      },
    }),
    { delay: 0 },
  ),
];
