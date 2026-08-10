import { m } from '@aio-proxy/i18n';
import {
  ProviderRequestTransformRulesJsonSchema,
  ProviderRequestTransformRulesSchema,
  type ProviderRequestTransformRule,
} from '@aio-proxy/types';
import { FieldError } from '@aio-proxy/ui/components/field';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { JsonEditor, type JsonEditorValueAcknowledgement } from '@/components/json-editor/json-editor';
import type { JsonEditorValidation, JsonValue } from '@/components/json-editor/json-editor-state';

interface ProviderRequestTransformsJsonEditorProps {
  readonly value: readonly ProviderRequestTransformRule[];
  readonly onChange: (value: readonly ProviderRequestTransformRule[]) => void;
  readonly onValidityChange: (valid: boolean) => void;
}

interface SemanticIssue {
  readonly path: string;
  readonly code: string;
}

interface SemanticIssueState {
  readonly canonicalDraft: string;
  readonly issue: SemanticIssue;
}

interface ValidCandidate {
  readonly draft: string;
  readonly value: readonly ProviderRequestTransformRule[];
  readonly expectValueAcknowledgement?: JsonEditorValueAcknowledgement;
}

const jsonPath = (path: readonly PropertyKey[]) =>
  path.reduce<string>(
    (result, segment) => (typeof segment === 'number' ? `${result}[${segment}]` : `${result}.${String(segment)}`),
    '$',
  );

export const ProviderRequestTransformsJsonEditor: React.FC<ProviderRequestTransformsJsonEditorProps> = ({
  value,
  onChange,
  onValidityChange,
}) => {
  const errorId = useId();
  const [semanticIssue, setSemanticIssue] = useState<SemanticIssueState>();
  const canonicalDraft = JSON.stringify(value, null, 2);
  const [initialCandidate] = useState<ValidCandidate>(() => ({ draft: canonicalDraft, value }));
  const canonicalDraftRef = useRef(canonicalDraft);
  const canonicalValue = useRef(value);
  const latestDraft = useRef(initialCandidate.draft);
  const candidate = useRef<ValidCandidate | undefined>(initialCandidate);
  const lastEmitted = useRef<ValidCandidate>(initialCandidate);

  useEffect(() => {
    canonicalDraftRef.current = canonicalDraft;
    canonicalValue.current = value;
  }, [canonicalDraft, value]);

  useEffect(() => {
    const next: ValidCandidate = { draft: canonicalDraft, value: canonicalValue.current };
    latestDraft.current = next.draft;
    candidate.current = next;
    lastEmitted.current = next;
  }, [canonicalDraft]);

  const handleDraftChange = useCallback(
    (draft: string) => {
      latestDraft.current = draft;
      candidate.current = undefined;
      setSemanticIssue(undefined);
      onValidityChange(false);
    },
    [onValidityChange],
  );

  const handleValueChange = useCallback(
    (nextValue: JsonValue | undefined, draft: string, expectValueAcknowledgement: JsonEditorValueAcknowledgement) => {
      const result = ProviderRequestTransformRulesSchema.safeParse(nextValue);
      candidate.current = result.success ? { draft, value: result.data, expectValueAcknowledgement } : undefined;
      setSemanticIssue(
        result.success
          ? undefined
          : {
              canonicalDraft,
              issue: {
                path: jsonPath(result.error.issues[0]?.path ?? []),
                code: result.error.issues[0]?.message ?? 'INVALID_TRANSFORM',
              },
            },
      );
      onValidityChange(false);
    },
    [canonicalDraft, onValidityChange],
  );

  const handleValidationChange = useCallback(
    (validation: JsonEditorValidation, draft: string) => {
      let current = candidate.current;
      if (draft === canonicalDraftRef.current && latestDraft.current !== draft) {
        current = { draft, value: canonicalValue.current };
        latestDraft.current = draft;
        candidate.current = current;
        lastEmitted.current = current;
        setSemanticIssue(undefined);
      }
      const valid = validation.valid && latestDraft.current === draft && current?.draft === draft;
      onValidityChange(valid);
      if (!valid || current === undefined || current === lastEmitted.current) return;
      current.expectValueAcknowledgement?.(current.value as unknown as JsonValue);
      lastEmitted.current = current;
      onChange(current.value);
    },
    [onChange, onValidityChange],
  );

  const visibleSemanticIssue = semanticIssue?.canonicalDraft === canonicalDraft ? semanticIssue.issue : undefined;

  return (
    <div className="space-y-2">
      <JsonEditor
        value={value as unknown as JsonValue}
        schema={ProviderRequestTransformRulesJsonSchema}
        ariaLabel={m['dashboard.providers.transforms.json_label']()}
        externalInvalid={visibleSemanticIssue !== undefined}
        {...(visibleSemanticIssue === undefined ? {} : { errorDescriptionId: errorId })}
        onDraftChange={handleDraftChange}
        onValueChange={handleValueChange}
        onValidationChange={handleValidationChange}
      />
      {visibleSemanticIssue === undefined ? null : (
        <FieldError id={errorId}>{m['dashboard.providers.transforms.invalid'](visibleSemanticIssue)}</FieldError>
      )}
    </div>
  );
};
