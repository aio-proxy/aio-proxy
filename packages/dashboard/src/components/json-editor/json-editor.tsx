import type { Monaco, OnMount } from "@monaco-editor/react";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { CodeEditor } from "@/components/code-editor";

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
} from "./json-editor-state";
import { registerJsonSchema, validateJsonModel } from "./json-schema-registry";

export type JsonEditorProps = {
  readonly value: JsonValue | undefined;
  readonly schema?: JsonSchema;
  readonly onValueChange: (value: JsonValue | undefined) => void;
  readonly onValidationChange?: (validation: JsonEditorValidation) => void;
  readonly externalInvalid?: boolean;
  readonly errorDescriptionId?: string;
  readonly id?: string;
  readonly className?: string;
  readonly height?: string | number;
};

const formatJsonValue = (value: JsonValue | undefined) => (value === undefined ? "" : JSON.stringify(value, null, 2));

export const JsonEditor: React.FC<JsonEditorProps> = ({
  value,
  schema,
  onValueChange,
  onValidationChange,
  externalInvalid,
  errorDescriptionId,
  id,
  className,
  height,
}) => {
  const generatedId = useId();
  const modelUri = useMemo(() => createJsonEditorModelUri(generatedId, id), [generatedId, id]);
  const [draft, setDraft] = useState(() => formatJsonValue(value));
  const [monaco, setMonaco] = useState<Monaco>();
  const [editor, setEditor] = useState<Parameters<OnMount>[0]>();
  const [validationState, setValidationState] = useState(() =>
    createJsonValidationState(formatJsonValue(value), schema),
  );
  const lastEmittedValue = useRef(value);

  useEffect(() => {
    if (Object.is(value, lastEmittedValue.current)) return;
    lastEmittedValue.current = value;
    const nextDraft = formatJsonValue(value);
    setDraft(nextDraft);
    setValidationState((current) => beginJsonValidation(current, nextDraft, schema));
  }, [schema, value]);

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
  const externalValuePending = !Object.is(value, lastEmittedValue.current);
  const validation = useMemo(
    () =>
      mergeJsonValidation({
        syntaxValid: parseResult.ok,
        markers: validationState.markers,
        schema,
        pending:
          externalValuePending ||
          validationState.pending ||
          validationState.draft !== draft ||
          validationState.schema !== schema,
      }),
    [draft, externalValuePending, parseResult.ok, schema, validationState],
  );

  useEffect(() => {
    onValidationChange?.(validation);
  }, [onValidationChange, validation]);

  const handleChange = useCallback(
    (nextDraft: string | undefined) => {
      const nextValue = nextDraft ?? "";
      setDraft(nextValue);
      setValidationState((current) => beginJsonValidation(current, nextValue, schema));
      const parsed = parseJsonDraft(nextValue);
      if (!parsed.ok) return;

      lastEmittedValue.current = parsed.value;
      onValueChange(parsed.value);
    },
    [onValueChange, schema],
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
      ariaDescribedBy={errorDescriptionId}
      language="json"
      onChange={handleChange}
      onMount={handleMount}
      onValidate={handleValidationReady}
      path={modelUri}
      value={draft}
    />
  );
};
