import { m } from '@aio-proxy/i18n';
import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import type { ExpressionNode } from '@react-querybuilder/expr';
import { QueryBuilderExpressions } from '@react-querybuilder/expr/ui';
import { isEqual } from 'es-toolkit/predicate';
import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import {
  prepareRuleGroup,
  parseNumber,
  QueryBuilder,
  type DefaultRuleGroupType,
  type DefaultRuleType,
} from 'react-querybuilder';

import './request-transform-expression-tree.css';

import {
  parseRequestTransformCondition,
  requestTransformFunctionMeta,
  serializeRequestTransformCondition,
} from '../../lib/request-transforms';
import { QueryBuilderShadcn } from './query-builder';
import {
  allowRequestTransformFunctionsOnLhs,
  getRequestTransformAccessibleDescription,
  getRequestTransformCombinators,
  getRequestTransformConditionFields,
  getRequestTransformExpressionTranslations,
  getRequestTransformOperators,
  getRequestTransformOperatorsForField,
  getRequestTransformTranslations,
  getRequestTransformValueSources,
  normalizeRequestTransformQuery,
} from './request-transform-condition-metadata';
import { RequestTransformFieldSelector } from './request-transform-field-selector';

type Condition = NonNullable<ProviderRequestTransformRule['when']>;

export interface RequestTransformConditionEditorProps {
  readonly value: Condition;
  readonly onChange: (value: Condition) => void;
  readonly onValidityChange?: (valid: boolean) => void;
}

const collectRules = (query: DefaultRuleGroupType, rules = new Map<string, DefaultRuleType>()) => {
  for (const item of query.rules) {
    if ('rules' in item) collectRules(item, rules);
    else if (item.id !== undefined) rules.set(item.id, item);
  }
  return rules;
};

const normalizeOperatorTransitions = (
  previousQuery: DefaultRuleGroupType,
  nextQuery: DefaultRuleGroupType,
): DefaultRuleGroupType => {
  const previousRules = collectRules(previousQuery);
  const normalizeGroup = (group: DefaultRuleGroupType): DefaultRuleGroupType => ({
    ...group,
    rules: group.rules.map((item) => {
      if ('rules' in item) return normalizeGroup(item);
      const previousRule = item.id === undefined ? undefined : previousRules.get(item.id);
      if (previousRule === undefined || previousRule.operator === item.operator) return item;
      if (String(item.operator) === 'regex') return { ...item, value: { regex: '', options: '' } };
      if (String(previousRule.operator) === 'regex') return { ...item, value: '' };
      return item;
    }),
  });
  return normalizeGroup(nextQuery);
};

const numericBodyOperators = new Set(['>', '>=', '<', '<=']);
const numericExpressionFunctions = new Set(['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'abs', 'mod']);

const numericLiteral = (value: unknown): unknown =>
  typeof value === 'string' ? parseNumber(value, { parseNumbers: true }) : value;

const normalizeNumericExpressionEdit = (
  previousNode: ExpressionNode | undefined,
  nextNode: ExpressionNode,
  numericValue: boolean,
): ExpressionNode => {
  if (isEqual(previousNode, nextNode)) return nextNode;
  if (nextNode.kind === 'value') {
    return numericValue ? { ...nextNode, value: numericLiteral(nextNode.value) } : nextNode;
  }
  if (nextNode.kind !== 'func') return nextNode;
  const previousArgs = previousNode?.kind === 'func' && previousNode.fn === nextNode.fn ? previousNode.args : [];
  const numericArgs = numericExpressionFunctions.has(nextNode.fn);
  return {
    ...nextNode,
    args: nextNode.args.map((argument, index) =>
      normalizeNumericExpressionEdit(previousArgs[index], argument, numericArgs),
    ),
  };
};

const normalizeNumericBodyLiterals = (
  previousQuery: DefaultRuleGroupType,
  nextQuery: DefaultRuleGroupType,
): DefaultRuleGroupType => {
  const previousRules = collectRules(previousQuery);
  const normalizeGroup = (group: DefaultRuleGroupType): DefaultRuleGroupType => ({
    ...group,
    rules: group.rules.map((item) => {
      if ('rules' in item) return normalizeGroup(item);
      const previousRule = item.id === undefined ? undefined : previousRules.get(item.id);
      if (previousRule === undefined || isEqual(previousRule, item)) return item;
      if (
        (!item.field.startsWith('request.body:') && !item.field.startsWith('original.body:')) ||
        !numericBodyOperators.has(item.operator)
      ) {
        return item;
      }
      let value = item.value;
      if (item.valueSource === 'expression') {
        value = normalizeNumericExpressionEdit(
          previousRule.valueSource === 'expression' ? (previousRule.value as ExpressionNode) : undefined,
          item.value as ExpressionNode,
          true,
        );
      } else if (!isEqual(previousRule.value, item.value)) {
        value = numericLiteral(item.value);
      }
      return {
        ...item,
        ...(item.lhs === undefined
          ? {}
          : {
              lhs: normalizeNumericExpressionEdit(
                previousRule.lhs as ExpressionNode | undefined,
                item.lhs as ExpressionNode,
                false,
              ),
            }),
        value,
      };
    }),
  });
  return normalizeGroup(nextQuery);
};

const prepareConditionQuery = (value: Condition): DefaultRuleGroupType =>
  prepareRuleGroup(normalizeRequestTransformQuery(parseRequestTransformCondition(value)));

export const RequestTransformConditionEditor: React.FC<RequestTransformConditionEditorProps> = ({
  value,
  onChange,
  onValidityChange,
}) => {
  const [query, setQuery] = useState(() => prepareConditionQuery(value));
  const expectedValue = useRef(value);
  const fields = getRequestTransformConditionFields();
  const operators = getRequestTransformOperators();

  useEffect(() => {
    if (isEqual(value, expectedValue.current)) return;
    expectedValue.current = value;
    setQuery(prepareConditionQuery(value));
    onValidityChange?.(true);
  }, [onValidityChange, value]);

  const handleQueryChange = (nextQuery: DefaultRuleGroupType) => {
    const normalizedQuery = normalizeNumericBodyLiterals(query, normalizeOperatorTransitions(query, nextQuery));
    setQuery(normalizedQuery);
    const nextValue = serializeRequestTransformCondition(normalizedQuery);
    try {
      parseRequestTransformCondition(nextValue);
    } catch {
      onValidityChange?.(false);
      return;
    }
    onValidityChange?.(true);
    expectedValue.current = nextValue;
    onChange(nextValue);
  };

  return (
    <QueryBuilderShadcn
      controlElements={{ fieldSelector: RequestTransformFieldSelector }}
      controlClassnames={{
        queryBuilder: 'space-y-2',
        // `!` overrides `react-querybuilder/dist/query-builder.css`'s own `.ruleGroup` rules.
        ruleGroup: 'space-y-2 rounded-xl! border border-border! bg-muted/20! p-2.5',
        header: 'flex flex-wrap items-center gap-2',
        body: 'space-y-2',
        rule: 'flex items-start gap-2 rounded-lg bg-background/70 p-2',
      }}
    >
      <QueryBuilderExpressions
        functions={requestTransformFunctionMeta}
        translations={getRequestTransformExpressionTranslations()}
        allowFunctionsOnLHS={allowRequestTransformFunctionsOnLhs}
      >
        <div
          className="request-transform-expression-tree w-full min-w-0"
          style={
            {
              '--expr-arg-label': `"${m['dashboard.providers.transforms.condition.argument.prefix']()} "`,
            } as React.CSSProperties
          }
        >
          <QueryBuilder
            fields={fields}
            operators={operators}
            combinators={getRequestTransformCombinators()}
            query={query}
            onQueryChange={handleQueryChange}
            translations={getRequestTransformTranslations()}
            getOperators={(field) => getRequestTransformOperatorsForField(field, operators)}
            getValueSources={getRequestTransformValueSources}
            accessibleDescriptionGenerator={getRequestTransformAccessibleDescription}
            showNotToggle
            listsAsArrays
            resetOnFieldChange={false}
            enableMountQueryChange={false}
          />
        </div>
      </QueryBuilderExpressions>
    </QueryBuilderShadcn>
  );
};
