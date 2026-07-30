import { m } from '@aio-proxy/i18n';
import {
  ProviderRequestTransformRulesJsonSchema,
  ProviderRequestTransformRulesSchema,
  type ProviderRequestTransformRule,
} from '@aio-proxy/types';
import { useCallback, useId, useRef, useState } from 'react';

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
  const semanticValid = useRef(true);

  const handleValueChange = useCallback(
    (nextValue: JsonValue | undefined) => {
      const result = ProviderRequestTransformRulesSchema.safeParse(nextValue);
      semanticValid.current = result.success;
      setSemanticIssue(
        result.success
          ? undefined
          : {
              path: jsonPath(result.error.issues[0]?.path ?? []),
              code: result.error.issues[0]?.message ?? 'INVALID_TRANSFORM',
            },
      );
      onValidityChange(false);
      if (result.success) onChange(result.data);
    },
    [onChange, onValidityChange],
  );

  const handleValidationChange = useCallback(
    (validation: JsonEditorValidation) => onValidityChange(validation.valid && semanticValid.current),
    [onValidityChange],
  );

  return (
    <div className="space-y-2">
      <JsonEditor
        value={value as unknown as JsonValue}
        schema={ProviderRequestTransformRulesJsonSchema}
        ariaLabel={m['dashboard.providers.transforms.json_label']()}
        externalInvalid={semanticIssue !== undefined}
        {...(semanticIssue === undefined ? {} : { errorDescriptionId: errorId })}
        onValueChange={handleValueChange}
        onValidationChange={handleValidationChange}
      />
      {semanticIssue === undefined ? null : (
        <FieldError id={errorId}>{m['dashboard.providers.transforms.invalid'](semanticIssue)}</FieldError>
      )}
    </div>
  );
};
