import { m } from '@aio-proxy/i18n';
import {
  ProviderRequestTransformRulesJsonSchema,
  ProviderRequestTransformRulesSchema,
  type ProviderRequestTransformRule,
} from '@aio-proxy/types';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { JsonEditor } from '@/components/json-editor/json-editor';
import type { JsonEditorValidation, JsonValue } from '@/components/json-editor/json-editor-state';
import { FieldError } from '@/components/ui/field';

interface ProviderRequestTransformsJsonEditorProps {
  readonly value: readonly ProviderRequestTransformRule[];
  readonly onChange: (value: readonly ProviderRequestTransformRule[]) => void;
  readonly onValidityChange: (valid: boolean) => void;
}

interface SemanticIssue {
  readonly path: string;
  readonly code: string;
}

interface ValidCandidate {
  readonly draft: string;
  readonly value: readonly ProviderRequestTransformRule[];
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
  const [semanticIssue, setSemanticIssue] = useState<SemanticIssue>();
  const initialCandidate = useRef<ValidCandidate>({ draft: JSON.stringify(value, null, 2), value }).current;
  const latestDraft = useRef(initialCandidate.draft);
  const candidate = useRef<ValidCandidate | undefined>(initialCandidate);
  const lastEmitted = useRef<ValidCandidate>(initialCandidate);

  useEffect(() => {
    const next: ValidCandidate = { draft: JSON.stringify(value, null, 2), value };
    latestDraft.current = next.draft;
    candidate.current = next;
    lastEmitted.current = next;
    setSemanticIssue(undefined);
  }, [value]);

  const handleDraftChange = useCallback(
    (draft: string) => {
      latestDraft.current = draft;
      candidate.current = undefined;
      onValidityChange(false);
    },
    [onValidityChange],
  );

  const handleValueChange = useCallback(
    (nextValue: JsonValue | undefined, draft: string) => {
      const result = ProviderRequestTransformRulesSchema.safeParse(nextValue);
      candidate.current = result.success ? { draft, value: result.data } : undefined;
      setSemanticIssue(
        result.success
          ? undefined
          : {
              path: jsonPath(result.error.issues[0]?.path ?? []),
              code: result.error.issues[0]?.message ?? 'INVALID_TRANSFORM',
            },
      );
      onValidityChange(false);
    },
    [onValidityChange],
  );

  const handleValidationChange = useCallback(
    (validation: JsonEditorValidation, draft: string) => {
      const current = candidate.current;
      const valid = validation.valid && latestDraft.current === draft && current?.draft === draft;
      onValidityChange(valid);
      if (!valid || current === lastEmitted.current) return;
      lastEmitted.current = current;
      onChange(current.value);
    },
    [onChange, onValidityChange],
  );

  return (
    <div className="space-y-2">
      <JsonEditor
        value={value as unknown as JsonValue}
        schema={ProviderRequestTransformRulesJsonSchema}
        ariaLabel={m['dashboard.providers.transforms.json_label']()}
        externalInvalid={semanticIssue !== undefined}
        {...(semanticIssue === undefined ? {} : { errorDescriptionId: errorId })}
        onDraftChange={handleDraftChange}
        onValueChange={handleValueChange}
        onValidationChange={handleValidationChange}
      />
      {semanticIssue === undefined ? null : (
        <FieldError id={errorId}>{m['dashboard.providers.transforms.invalid'](semanticIssue)}</FieldError>
      )}
    </div>
  );
};
