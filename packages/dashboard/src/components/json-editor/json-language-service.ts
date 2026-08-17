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
  type LanguageService,
} from 'vscode-json-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';

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

let languageService: LanguageService | undefined;

const getJsonLanguageService = () => {
  languageService ??= getLanguageService({ clientCapabilities: ClientCapabilities.LATEST });
  return languageService;
};

export const toJsonValidationMarkers = (diagnostics: readonly Diagnostic[]): readonly JsonValidationMarker[] =>
  diagnostics.flatMap((diagnostic): readonly JsonValidationMarker[] => {
    if (diagnostic.severity === DiagnosticSeverity.Error) return [{ severity: 'error' }];
    if (diagnostic.severity === DiagnosticSeverity.Warning) return [{ severity: 'warning' }];
    return [];
  });

export const configureJsonSchemas = (schemas: readonly JsonSchemaRegistration[]) => {
  getJsonLanguageService().configure({
    validate: true,
    allowComments: false,
    schemas: schemas.map(({ fileMatch, schema, ...registration }) => ({
      ...registration,
      fileMatch: [...fileMatch],
      schema: withMarkdownDescriptions(schema),
    })),
  });
};

export const validateJsonModel = async (modelUri: string, text: string) => {
  const service = getJsonLanguageService();
  const document = TextDocument.create(modelUri, 'json', 1, text);
  const diagnostics = await service.doValidation(document, service.parseJSONDocument(document), documentSettings);
  return toJsonValidationMarkers(diagnostics);
};

export const createJsonCompletionSource = (): CompletionSource => {
  const service = getJsonLanguageService();
  const source = createCompletionSource({
    markdownToDom,
    triggerCharacters: '": \n\t,',
    doComplete: (document, position) => service.doComplete(document, position, service.parseJSONDocument(document)),
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
  const service = getJsonLanguageService();
  return createHoverTooltipSource({
    markdownToDom,
    doHover: (document, position) => service.doHover(document, position, service.parseJSONDocument(document)),
  });
};

export const createJsonLanguageExtensions = (uri: string): Extension[] => {
  const service = getJsonLanguageService();
  const parse = (document: TextDocument) => service.parseJSONDocument(document);

  return [
    textDocument(uri),
    autocompletion({
      icons: false,
      override: [createJsonCompletionSource()],
    }),
    hoverTooltip(createJsonHoverTooltipSource()),
    linter(
      createLintSource({
        doDiagnostics: (document) => service.doValidation(document, parse(document), documentSettings),
      }),
    ),
  ];
};
