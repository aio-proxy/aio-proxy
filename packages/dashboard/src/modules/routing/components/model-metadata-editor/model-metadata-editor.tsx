import { m } from '@aio-proxy/i18n';
import {
  MODELS_DEV_SCHEMA_ID,
  ModelMetadataJsonSchema,
  ModelMetadataSchema,
  type ModelMetadataInput,
} from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Label } from '@aio-proxy/ui/components/label';
import { useQuery } from '@tanstack/react-query';
import { isEqual, isPlainObject } from 'es-toolkit/predicate';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

import {
  JsonEditor,
  registerJsonSchema,
  type JsonEditorValueAcknowledgement,
  type JsonValue,
} from '@/components/json-editor';

import { createModelsDevModelSchemaDocument } from '../../lib/models-dev-model-schema';
import { modelsDevSlugsQueryOptions } from '../../services/models-dev-service';
import { ModelMetadataVisualTab } from '../model-metadata-visual-tab';

export interface ModelMetadataEditorProps {
  /** Model ID for the accessible labels; an identifier, not translatable copy. */
  readonly model: string;
  readonly value: ModelMetadataInput | undefined;
  readonly onChange: (next: ModelMetadataInput | undefined) => void;
  /**
   * Reports whether the visible draft is something a save could persist (valid JSON passing the
   * schema, or an emptied draft meaning "clear"). Owners must gate their submit on it: an invalid
   * draft stays local, so saving over it would silently persist the last valid value instead of
   * what the user sees.
   */
  readonly onValidityChange?: (valid: boolean) => void;
  /** Shows the metadata without letting it be edited, for a config the dashboard cannot write. */
  readonly readOnly?: boolean;
  /** Shown below the form, above the JSON link; hidden while the JSON editor replaces the form. */
  readonly children?: React.ReactNode;
}

const serialize = (value: ModelMetadataInput | undefined) => JSON.stringify(value ?? {}, null, 2);

/** What the editor reports outward: an emptied draft means "cleared", not "empty object". */
const normalize = (value: ModelMetadataInput): ModelMetadataInput | undefined =>
  Object.keys(value).length === 0 ? undefined : value;

// `extend` is the base layer every other field goes on top of, so the JSON reads it first, whatever
// order the schema emits keys in.
const referenceFirst = (value: ModelMetadataInput): ModelMetadataInput => {
  const { extend, ...fields } = value;
  return extend === undefined ? value : { extend, ...fields };
};

const editorValue = (draft: string, value: ModelMetadataInput | undefined): JsonValue | undefined =>
  draft.trim() === '' ? undefined : (referenceFirst(value ?? {}) as JsonValue);

/**
 * Inline metadata editor: a form, with JSON as the way out for every key the form does not reach. Controlled: every schema-valid draft change is
 * pushed out through `onChange` (an emptied draft as `undefined`); invalid JSON stays local until
 * repaired, so the owner never receives a value no saved record could hold.
 */
export const ModelMetadataEditor: React.FC<ModelMetadataEditorProps> = ({
  model,
  value,
  onChange,
  onValidityChange,
  readOnly = false,
  children,
}) => {
  const editorId = useId();
  const slugs = useQuery(modelsDevSlugsQueryOptions());
  useEffect(
    () =>
      registerJsonSchema(MODELS_DEV_SCHEMA_ID, {
        uri: MODELS_DEV_SCHEMA_ID,
        fileMatch: [],
        schema: createModelsDevModelSchemaDocument(slugs.data?.slugs),
      }),
    [slugs.data?.slugs],
  );
  const [draft, setDraft] = useState(() => serialize(value));
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  // Re-sync from outside (owner reseeded after a reload) but never from our own echo: when the
  // incoming value is what the current draft already parses to, the draft is the better display.
  const [lastValue, setLastValue] = useState(value);
  const parsed = useMemo(() => {
    try {
      return ModelMetadataSchema.safeParse(JSON.parse(draft));
    } catch {
      return { success: false } as const;
    }
  }, [draft]);
  if (value !== lastValue) {
    setLastValue(value);
    const echoed = parsed.success && isEqual(normalize(parsed.data), value);
    if (!echoed) setDraft(serialize(value));
  }

  // An emptied draft is a valid "clear", not invalid JSON.
  const valid = parsed.success || draft.trim() === '';
  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);

  const updateDraft = (next: string) => {
    setDraft(next);
    // An emptied editor is a legitimate "clear everything" flow with no keys to lose.
    if (next.trim() === '') {
      onChange(undefined);
      return;
    }
    try {
      const result = ModelMetadataSchema.safeParse(JSON.parse(next));
      if (result.success) onChange(normalize(result.data));
    } catch {
      // Unparseable text stays local; the owner keeps the last valid value.
    }
  };

  const handleJsonValueChange = (
    _next: JsonValue | undefined,
    nextDraft: string,
    ack: JsonEditorValueAcknowledgement,
  ) => {
    updateDraft(nextDraft);
    if (nextDraft.trim() === '') {
      ack(undefined);
      return;
    }
    try {
      const result = ModelMetadataSchema.safeParse(JSON.parse(nextDraft));
      if (result.success) ack((normalize(result.data) ?? {}) as JsonValue);
    } catch {
      // Syntax stays in the editor; Zod rejection is reported as externalInvalid.
    }
  };

  // Deliberately not `parsed.data`: the visual tab must merge over a draft the schema rejects
  // (e.g. `limit.input > limit.context`) instead of replacing it with `{}`.
  const rawValue = useMemo((): Readonly<Record<string, unknown>> | undefined => {
    // An emptied editor is a legitimate "start over" flow and has no keys to lose, so it stays
    // open to the visual tab. Non-empty broken text does not.
    if (draft.trim() === '') return {};
    try {
      const parsedDraft: unknown = JSON.parse(draft);
      return isPlainObject(parsedDraft) ? parsedDraft : undefined;
    } catch {
      return undefined;
    }
  }, [draft]);
  // One source of truth for the tab: the user's own choice, overridden only while the draft cannot be
  // shown as a form. Repairing the draft therefore returns the user to the tab they picked.
  const activeMode = rawValue === undefined ? 'json' : mode;

  return (
    <div data-testid="model-metadata-editor" className="space-y-6">
      {activeMode === 'visual' && rawValue !== undefined ? (
        <>
          <fieldset disabled={readOnly}>
            <ModelMetadataVisualTab
              model={model}
              value={rawValue}
              onChange={(next) => updateDraft(JSON.stringify(next, null, 2))}
            />
          </fieldset>
          {children}
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-auto px-0"
            data-testid="metadata-tab-json"
            onClick={() => setMode('json')}
          >
            {m['dashboard.routing.editor.metadata_tab_json']()}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </>
      ) : (
        <div className="space-y-3">
          {/*
            Disabled while the draft is not a JSON object: the form merges over the parsed draft and
            writes the whole result back, so entering it on unparseable text would silently drop every
            key it cannot render (`name` among them). A form edit always emits `JSON.stringify` output,
            so this can never strand a user on the form.
          */}
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-auto px-0"
            data-testid="metadata-tab-visual"
            disabled={rawValue === undefined}
            aria-describedby={rawValue === undefined ? 'metadata-visual-blocked' : undefined}
            onClick={() => setMode('visual')}
          >
            <ArrowLeft data-icon="inline-start" />
            {m['dashboard.routing.editor.metadata_tab_visual']()}
          </Button>
          <Label htmlFor={editorId} className="sr-only">
            {m['dashboard.routing.editor.metadata_json_label']({ model })}
          </Label>
          <div data-testid="metadata-json-draft">
            <JsonEditor
              id={editorId}
              className="min-h-72"
              value={editorValue(draft, value)}
              schema={ModelMetadataJsonSchema}
              externalInvalid={!valid}
              readOnly={readOnly}
              onDraftChange={updateDraft}
              onValueChange={handleJsonValueChange}
            />
          </div>
          {rawValue === undefined ? (
            <p role="alert" id="metadata-visual-blocked" className="text-sm text-destructive">
              {m['dashboard.routing.editor.metadata_json_error']()}
            </p>
          ) : !parsed.success && 'error' in parsed && parsed.error.issues[0] !== undefined ? (
            <p role="alert" className="text-sm text-destructive">
              {m['dashboard.routing.editor.metadata_schema_error']({
                path: parsed.error.issues[0].path.join('.') || '.',
              })}
            </p>
          ) : !parsed.success ? (
            <p role="alert" className="text-sm text-destructive">
              {m['dashboard.routing.editor.metadata_json_error']()}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
};
