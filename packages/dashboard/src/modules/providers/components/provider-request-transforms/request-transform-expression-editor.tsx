import type { ExpressionNode } from '@react-querybuilder/expr';
import { ExpressionEditor } from '@react-querybuilder/expr/ui';
import { isEqual } from 'es-toolkit/predicate';
import { useEffect, useRef, useState } from 'react';
import { useQueryBuilder, type DefaultRuleGroupType } from 'react-querybuilder';

import {
  parseRequestTransformStages,
  requestTransformFunctionMeta,
  serializeRequestTransformStages,
} from '../../request-transforms';
import { getRequestTransformFields } from './request-transform-condition-metadata';

const emptyQuery: DefaultRuleGroupType = { combinator: 'and', rules: [] };
const ignoreQueryChange = () => undefined;
const validExpression = (expression: ExpressionNode): boolean => {
  try {
    parseRequestTransformStages(
      serializeRequestTransformStages([
        {
          kind: 'set',
          target: 'body',
          path: '__expression_probe__',
          value: { kind: 'expression', expression },
        },
      ]),
    );
    return true;
  } catch {
    return false;
  }
};

export interface RequestTransformExpressionEditorProps {
  readonly expression: ExpressionNode;
  readonly onChange: (expression: ExpressionNode) => void;
}

export const RequestTransformExpressionEditor: React.FC<RequestTransformExpressionEditorProps> = ({
  expression,
  onChange,
}) => {
  const [draft, setDraft] = useState(expression);
  const expectedExpression = useRef(expression);
  const { schema } = useQueryBuilder({
    fields: getRequestTransformFields(),
    query: emptyQuery,
    onQueryChange: ignoreQueryChange,
    enableMountQueryChange: false,
    parseNumbers: true,
  });

  useEffect(() => {
    if (isEqual(expression, expectedExpression.current)) return;
    expectedExpression.current = expression;
    setDraft(expression);
  }, [expression]);

  return (
    <ExpressionEditor
      node={draft}
      onChange={(nextExpression) => {
        setDraft(nextExpression);
        if (!validExpression(nextExpression)) return;
        expectedExpression.current = nextExpression;
        onChange(nextExpression);
      }}
      meta={requestTransformFunctionMeta}
      schema={schema}
      testID="transform-set-expression"
    />
  );
};
