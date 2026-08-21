import { m } from '@aio-proxy/i18n';
import { QueryBuilderExpressions } from '@react-querybuilder/expr/ui';
import type React from 'react';
import { QueryBuilderStateProvider } from 'react-querybuilder';

import {
  formatRequestTransformExpression,
  requestTransformFunctionMeta,
  type RequestTransformStageDraft,
} from '../../lib/request-transforms';
import { QueryBuilderShadcn } from './query-builder';
import { RequestTransformExpressionEditor } from './request-transform-expression-editor';
import { RequestTransformStaticValueEditor } from './request-transform-static-value-editor';

type SetStage = Extract<RequestTransformStageDraft, { kind: 'set' }>;

interface RequestTransformStageValueContentProps {
  readonly value: SetStage;
  readonly ruleName: string;
  readonly onChange: (value: RequestTransformStageDraft) => void;
  readonly onValidityChange: (valid: boolean) => void;
}

export const RequestTransformStageValueContent: React.FC<RequestTransformStageValueContentProps> = ({
  value,
  ruleName,
  onChange,
  onValidityChange,
}) =>
  value.value.kind === 'static' ? (
    <RequestTransformStaticValueEditor
      value={value.value.value}
      ruleName={ruleName}
      onChange={(nextValue) => onChange({ ...value, value: { kind: 'static', value: nextValue } })}
      onValidityChange={onValidityChange}
    />
  ) : (
    <div className="space-y-2">
      <div
        className="overflow-x-auto rounded-xl bg-muted/30 p-3"
        aria-label={m['dashboard.providers.transforms.value.scoped_label']({
          name: ruleName,
          label: m['dashboard.providers.transforms.value.computed_label'](),
        })}
      >
        {/* Two-column alignment, argument numbering and connector lines all come from `styles.css`. */}
        <div className="request-transform-expression-tree">
          <QueryBuilderStateProvider>
            <QueryBuilderShadcn>
              <QueryBuilderExpressions functions={requestTransformFunctionMeta}>
                <RequestTransformExpressionEditor
                  expression={value.value.expression}
                  onChange={(expression) => onChange({ ...value, value: { kind: 'expression', expression } })}
                  onValidityChange={onValidityChange}
                />
              </QueryBuilderExpressions>
            </QueryBuilderShadcn>
          </QueryBuilderStateProvider>
        </div>
      </div>
      <div className="flex min-w-0 items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs">
        <span className="shrink-0 text-muted-foreground">{m['dashboard.providers.transforms.value.preview']()}</span>
        <code
          className="min-w-0 font-mono break-all text-foreground"
          aria-label={m['dashboard.providers.transforms.value.preview_label']({ name: ruleName })}
        >
          {formatRequestTransformExpression(value.value.expression)}
        </code>
      </div>
    </div>
  );
