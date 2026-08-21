import { useCallback, useEffect, useId, useMemo, useReducer, useRef } from 'react';

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
import { createJsonLanguageExtensions } from './json-language-service';
import { registerJsonSchema } from './json-schema-registry';

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
  readonly id?: string;
  readonly className?: string;
};

export type JsonEditorValueAcknowledgement = (value: JsonValue | undefined) => void;

const formatJsonValue = (value: JsonValue | undefined) => (value === undefined ? '' : JSON.stringify(value, null, 2));
const serializeJsonValue = (value: JsonValue | undefined) => (value === undefined ? '' : JSON.stringify(value));

interface ControlledJsonDraftState {
  readonly draft: string;
  readonly validationState: ReturnType<typeof createJsonValidationState>;
  readonly externalValuePending: boolean;
}

type ControlledJsonDraftAction =
  | { readonly type: 'change-draft'; readonly draft: string; readonly schema: JsonSchema | undefined }
  | { readonly type: 'sync-draft'; readonly draft: string; readonly schema: JsonSchema | undefined }
  | { readonly type: 'begin-validation'; readonly schema: JsonSchema | undefined }
  | {
      readonly type: 'complete-validation';
      readonly draft: string;
      readonly schema: JsonSchema | undefined;
      readonly markers: JsonEditorValidation['markers'];
    }
  | { readonly type: 'set-external-value-pending'; readonly pending: boolean };

const controlledJsonDraftReducer = (
  state: ControlledJsonDraftState,
  action: ControlledJsonDraftAction,
): ControlledJsonDraftState => {
  if (action.type === 'change-draft' || action.type === 'sync-draft') {
    return {
      draft: action.draft,
      validationState: beginJsonValidation(state.validationState, action.draft, action.schema),
      externalValuePending: action.type === 'sync-draft' ? false : state.externalValuePending,
    };
  }
  if (action.type === 'begin-validation') {
    return {
      ...state,
      validationState: beginJsonValidation(state.validationState, state.draft, action.schema),
    };
  }
  if (action.type === 'complete-validation') {
    if (
      !state.validationState.pending ||
      state.validationState.draft !== action.draft ||
      state.validationState.schema !== action.schema
    )
      return state;

    return {
      ...state,
      validationState: completeJsonValidation(state.validationState, state.validationState.generation, action.markers),
    };
  }
  return { ...state, externalValuePending: action.pending };
};

const useControlledJsonDraft = (value: JsonValue | undefined, schema: JsonSchema | undefined) => {
  const [state, dispatch] = useReducer(
    controlledJsonDraftReducer,
    { value, schema },
    ({ value: initialValue, schema }) => {
      const draft = formatJsonValue(initialValue);
      return {
        draft,
        validationState: createJsonValidationState(draft, schema),
        externalValuePending: false,
      };
    },
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
      if (nextContent === expectedContent) {
        dispatch({ type: 'set-external-value-pending', pending: false });
        return;
      }
    } else {
      if (nextContent === controlledContent.current) return;
      controlledContent.current = nextContent;
      const parsedDraft = parseJsonDraft(state.draft);
      if (parsedDraft.ok && serializeJsonValue(parsedDraft.value) === nextContent) return;
    }

    const nextDraft = formatJsonValue(value);
    dispatch({ type: 'sync-draft', draft: nextDraft, schema });
  });

  const expectValueAcknowledgement = useCallback<JsonEditorValueAcknowledgement>((expectedValue) => {
    awaitingControlledContent.current = serializeJsonValue(expectedValue);
  }, []);

  const markExternalValuePending = useCallback(() => {
    if (awaitingControlledContent.current !== null) {
      dispatch({ type: 'set-external-value-pending', pending: true });
    }
  }, []);

  return { ...state, dispatch, expectValueAcknowledgement, markExternalValuePending };
};

export const JsonEditor: React.FC<JsonEditorProps> = ({
  value,
  schema,
  onValueChange,
  onDraftChange,
  onValidationChange,
  externalInvalid,
  id,
  className,
}) => {
  const generatedId = useId();
  const modelUri = useMemo(() => createJsonEditorModelUri(generatedId, id), [generatedId, id]);
  const {
    draft,
    validationState,
    externalValuePending,
    dispatch,
    expectValueAcknowledgement,
    markExternalValuePending,
  } = useControlledJsonDraft(value, schema);
  const handleLanguageValidation = useCallback(
    (validatedDraft: string, markers: JsonEditorValidation['markers']) => {
      dispatch({ type: 'complete-validation', draft: validatedDraft, schema: validationState.schema, markers });
    },
    [dispatch, validationState.schema],
  );
  const languageExtensions = useMemo(
    () => createJsonLanguageExtensions(modelUri, validationState.schema, handleLanguageValidation),
    [handleLanguageValidation, modelUri, validationState.schema],
  );

  useEffect(() => {
    dispatch({ type: 'begin-validation', schema });
    if (!schema) return undefined;

    return registerJsonSchema(modelUri, {
      uri: `${modelUri}#schema`,
      fileMatch: [modelUri],
      schema,
    });
  }, [dispatch, modelUri, schema]);

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
    (nextDraft: string) => {
      onDraftChange?.(nextDraft);
      dispatch({ type: 'change-draft', draft: nextDraft, schema });
      const parsed = parseJsonDraft(nextDraft);
      if (!parsed.ok) return;

      onValueChange(parsed.value, nextDraft, expectValueAcknowledgement);
      markExternalValuePending();
    },
    [dispatch, expectValueAcknowledgement, markExternalValuePending, onDraftChange, onValueChange, schema],
  );

  return (
    <CodeEditor
      {...(className === undefined ? {} : { className })}
      {...(id === undefined ? {} : { id })}
      invalid={externalInvalid || !validation.valid}
      extensions={languageExtensions}
      onChange={handleChange}
      value={draft}
    />
  );
};
