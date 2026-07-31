import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { QueryBuilderExpressions } from '@react-querybuilder/expr/ui';
import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { QueryBuilder, type DefaultRuleGroupType } from 'react-querybuilder';

import 'react-querybuilder/dist/query-builder.css';

import { parseRequestTransformCondition, serializeRequestTransformCondition } from '../../request-transforms';
import { QueryBuilderShadcn } from './query-builder';
import {
  allowRequestTransformFunctionsOnLhs,
  getLocalizedRequestTransformFunctionMeta,
  getRequestTransformAccessibleDescription,
  getRequestTransformCombinators,
  getRequestTransformExpressionTranslations,
  getRequestTransformFields,
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
}

export const RequestTransformConditionEditor: React.FC<RequestTransformConditionEditorProps> = ({
  value,
  onChange,
}) => {
  const canonicalQuery = useMemo(() => normalizeRequestTransformQuery(parseRequestTransformCondition(value)), [value]);
  const [query, setQuery] = useState(canonicalQuery);
  const fields = getRequestTransformFields();
  const operators = getRequestTransformOperators();

  useEffect(() => setQuery(canonicalQuery), [canonicalQuery]);

  const handleQueryChange = (nextQuery: DefaultRuleGroupType) => {
    setQuery(nextQuery);
    const nextValue = serializeRequestTransformCondition(nextQuery);
    try {
      parseRequestTransformCondition(nextValue);
    } catch {
      return;
    }
    onChange(nextValue);
  };

  return (
    <div className="overflow-x-auto">
      <QueryBuilderShadcn
        controlElements={{ fieldSelector: RequestTransformFieldSelector }}
        controlClassnames={{
          queryBuilder: 'min-w-3xl space-y-3',
          ruleGroup: 'space-y-3 rounded-2xl border p-3',
          header: 'flex flex-wrap items-center gap-2',
          body: 'space-y-2',
          rule: 'flex flex-wrap items-center gap-2',
          shiftActions: 'inline-flex items-center',
        }}
      >
        <QueryBuilderExpressions
          functions={getLocalizedRequestTransformFunctionMeta()}
          translations={getRequestTransformExpressionTranslations()}
          allowFunctionsOnLHS={allowRequestTransformFunctionsOnLhs}
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
            showShiftActions
            listsAsArrays
            parseNumbers
            resetOnFieldChange={false}
            enableMountQueryChange={false}
          />
        </QueryBuilderExpressions>
      </QueryBuilderShadcn>
    </div>
  );
};
