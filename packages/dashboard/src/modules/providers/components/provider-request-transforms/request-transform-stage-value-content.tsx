import { m } from '@aio-proxy/i18n';
import { QueryBuilderExpressions } from '@react-querybuilder/expr/ui';
import type React from 'react';
import { QueryBuilderStateProvider } from 'react-querybuilder';

import type { RequestTransformStageDraft } from '../../lib/request-transforms';
import { QueryBuilderShadcn } from './query-builder';
import { getLocalizedRequestTransformFunctionMeta } from './request-transform-condition-metadata';
import { RequestTransformExpressionEditor } from './request-transform-expression-editor';
import { RequestTransformStaticValueEditor } from './request-transform-static-value-editor';

type SetStage = Extract<RequestTransformStageDraft, { kind: 'set' }>;

interface RequestTransformStageValueContentProps {
  readonly value: SetStage;
  readonly onChange: (value: RequestTransformStageDraft) => void;
  readonly onValidityChange: (valid: boolean) => void;
}

export const RequestTransformStageValueContent: React.FC<RequestTransformStageValueContentProps> = ({
  value,
  onChange,
  onValidityChange,
}) =>
  value.value.kind === 'static' ? (
    <RequestTransformStaticValueEditor
      value={value.value.value}
      onChange={(nextValue) => onChange({ ...value, value: { kind: 'static', value: nextValue } })}
      onValidityChange={onValidityChange}
    />
  ) : (
    <div className="overflow-x-auto" aria-label={m['dashboard.providers.transforms.value.computed_label']()}>
      <QueryBuilderStateProvider>
        <QueryBuilderShadcn>
          <QueryBuilderExpressions functions={getLocalizedRequestTransformFunctionMeta()}>
            <RequestTransformExpressionEditor
              expression={value.value.expression}
              onChange={(expression) => onChange({ ...value, value: { kind: 'expression', expression } })}
              onValidityChange={onValidityChange}
            />
          </QueryBuilderExpressions>
        </QueryBuilderShadcn>
      </QueryBuilderStateProvider>
    </div>
  );
