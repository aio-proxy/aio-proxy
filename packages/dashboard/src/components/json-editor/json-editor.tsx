import type { Monaco, OnMount } from '@monaco-editor/react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { CodeEditor } from '@/components/code-editor';

import {
  beginJsonValidation,
  completeJsonValidation,
  createJsonEditorModelUri,
  createJsonValidationState,
  type JsonEditorValidation,
  type JsonSchema,
  type JsonValue,
  mergeJsonValidation,
  parseJsonDraft,
} from './json-editor-state';
import { registerJsonSchema, validateJsonModel } from './json-schema-registry';

export type JsonEditorProps = {
  readonly value: JsonValue | undefined;
  readonly schema?: JsonSchema;
  readonly onValueChange: (
    value: JsonValue | undefined,
    draft: string,
    expectValueAcknowledgement: JsonEditorValueAcknowledgement,
  ) => void;
  readonly onDraftChange?: (draft: string) => void;
  readonly onValidationChange?: (validation: JsonEditorValidation, draft: string) => void;
  readonly externalInvalid?: boolean;
  readonly errorDescriptionId?: string;
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly className?: string;
  readonly height?: string | number;
};

export type JsonEditorValueAcknowledgement = (value: JsonValue | undefined) => void;

const formatJsonValue = (value: JsonValue | undefined) => (value === undefined ? '' : JSON.stringify(value, null, 2));
const serializeJsonValue = (value: JsonValue | undefined) => (value === undefined ? '' : JSON.stringify(value));

const useControlledJsonDraft = (value: JsonValue | undefined, schema: JsonSchema | undefined) => {
  const [draft, setDraft] = useState(() => formatJsonValue(value));
  const [validationState, setValidationState] = useState(() =>
    createJsonValidationState(formatJsonValue(value), schema),
  );
  const controlledContent = useRef(serializeJsonValue(value));
  const awaitingControlledContent = useRef<string | null>(null);

  // Run after every render so a same-content parent rerender can accept or reject an emitted value.
  useEffect(() => {
    const nextContent = serializeJsonValue(value);
    const expectedContent = awaitingControlledContent.current;
    if (expectedContent !== null) {
      awaitingControlledContent.current = null;
      controlledContent.current = nextContent;
      if (nextContent === expectedContent) return;
    } else {
      if (nextContent === controlledContent.current) return;
      controlledContent.current = nextContent;
      const parsedDraft = parseJsonDraft(draft);
      if (parsedDraft.ok && serializeJsonValue(parsedDraft.value) === nextContent) return;
    }

    const nextDraft = formatJsonValue(value);
    setDraft(nextDraft);
    setValidationState((current) => beginJsonValidation(current, nextDraft, schema));
  });

  const expectValueAcknowledgement = useCallback<JsonEditorValueAcknowledgement>((expectedValue) => {
    awaitingControlledContent.current = serializeJsonValue(expectedValue);
  }, []);
  const externalValuePending =
    awaitingControlledContent.current !== null && serializeJsonValue(value) !== awaitingControlledContent.current;

  return { draft, setDraft, validationState, setValidationState, externalValuePending, expectValueAcknowledgement };
};

export const JsonEditor: React.FC<JsonEditorProps> = ({
  value,
  schema,
  onValueChange,
  onDraftChange,
  onValidationChange,
  externalInvalid,
  errorDescriptionId,
  ariaLabel,
  id,
  className,
  height,
}) => {
  const generatedId = useId();
  const modelUri = useMemo(() => createJsonEditorModelUri(generatedId, id), [generatedId, id]);
  const [monaco, setMonaco] = useState<Monaco>();
  const [editor, setEditor] = useState<Parameters<OnMount>[0]>();
  const { draft, setDraft, validationState, setValidationState, externalValuePending, expectValueAcknowledgement } =
    useControlledJsonDraft(value, schema);

  useEffect(() => {
    setValidationState((current) => beginJsonValidation(current, current.draft, schema));
    if (!monaco || !schema) return undefined;

    return registerJsonSchema(monaco, modelUri, {
      uri: `${modelUri}#schema`,
      fileMatch: [modelUri],
      schema,
    });
  }, [modelUri, monaco, schema]);

  useEffect(() => {
    if (
      schema === undefined ||
      !editor ||
      !monaco ||
      !validationState.pending ||
      validationState.draft !== draft ||
      validationState.schema !== schema
    )
      return;

    const generation = validationState.generation;
    let active = true;
    if (editor.getModel()?.getValue() !== validationState.draft) return;

    void validateJsonModel(monaco, modelUri)
      .then((nextMarkers) => {
        if (active) setValidationState((current) => completeJsonValidation(current, generation, nextMarkers));
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [draft, editor, modelUri, monaco, schema, validationState]);

  const parseResult = parseJsonDraft(draft);
  const draftValidation = useMemo(
    () =>
      mergeJsonValidation({
        syntaxValid: parseResult.ok,
        markers: validationState.markers,
        ...(schema === undefined ? {} : { schema }),
        pending: validationState.pending || validationState.draft !== draft || validationState.schema !== schema,
      }),
    [draft, parseResult.ok, schema, validationState],
  );
  const validation = useMemo(
    () => ({
      ...draftValidation,
      valid: draftValidation.valid && !externalValuePending,
      pending: draftValidation.pending || externalValuePending,
    }),
    [draftValidation, externalValuePending],
  );

  useEffect(() => {
    onValidationChange?.(validation, draft);
  }, [draft, onValidationChange, validation]);

  const handleChange = useCallback(
    (nextDraft: string | undefined) => {
      const nextValue = nextDraft ?? '';
      onDraftChange?.(nextValue);
      setDraft(nextValue);
      setValidationState((current) => beginJsonValidation(current, nextValue, schema));
      const parsed = parseJsonDraft(nextValue);
      if (!parsed.ok) return;

      onValueChange(parsed.value, nextValue, expectValueAcknowledgement);
    },
    [expectValueAcknowledgement, onDraftChange, onValueChange, schema],
  );

  const handleMount = useCallback<OnMount>((nextEditor, nextMonaco) => {
    setEditor(nextEditor);
    setMonaco(nextMonaco);
  }, []);

  const handleValidationReady = useCallback(() => {
    setValidationState((current) => beginJsonValidation(current, current.draft, current.schema));
  }, []);

  return (
    <CodeEditor
      {...(className === undefined ? {} : { className })}
      height={height ?? 240}
      invalid={externalInvalid || !validation.valid}
      {...(errorDescriptionId === undefined ? {} : { ariaDescribedBy: errorDescriptionId })}
      language="json"
      {...(ariaLabel === undefined ? {} : { options: { ariaLabel } })}
      onChange={handleChange}
      onMount={handleMount}
      onValidate={handleValidationReady}
      path={modelUri}
      value={draft}
    />
  );
};
