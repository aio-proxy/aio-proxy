import { m } from '@aio-proxy/i18n';
import type { ExpressionFunctionMetaRegistry, ExpressionNode } from '@react-querybuilder/expr';
import type { TranslationsExpr } from '@react-querybuilder/expr/ui';
import type {
  Combinator,
  DefaultRuleGroupType,
  DefaultRuleType,
  Field,
  Operator,
  Translations,
  ValueSources,
} from 'react-querybuilder';

import { requestTransformFunctionMeta } from '../../request-transforms';

const comparisonOperators = new Set(['=', '!=', '>', '>=', '<', '<=']);
const headerOperatorNames = new Set(['=', '!=', 'exists', 'doesNotExist', 'pattern', 'regex']);

export const getRequestTransformFields = (): Field[] => [
  { name: 'provider.id', label: m['dashboard.providers.transforms.condition.field.provider_id']() },
  { name: 'provider.kind', label: m['dashboard.providers.transforms.condition.field.provider_kind']() },
  { name: 'provider.protocol', label: m['dashboard.providers.transforms.condition.field.provider_protocol']() },
  { name: 'request.model', label: m['dashboard.providers.transforms.condition.field.current_model']() },
  { name: 'request.requestedModel', label: m['dashboard.providers.transforms.condition.field.requested_model']() },
  {
    name: 'request.sourceProtocol',
    label: m['dashboard.providers.transforms.condition.field.source_protocol'](),
  },
  {
    name: 'request.targetProtocol',
    label: m['dashboard.providers.transforms.condition.field.target_protocol'](),
  },
  { name: 'request.method', label: m['dashboard.providers.transforms.condition.field.method']() },
  { name: 'request.url', label: m['dashboard.providers.transforms.condition.field.url']() },
  { name: 'request.body:', label: m['dashboard.providers.transforms.condition.field.current_body']() },
  { name: 'original.body:', label: m['dashboard.providers.transforms.condition.field.original_body']() },
  { name: 'request.header:', label: m['dashboard.providers.transforms.condition.field.current_header']() },
  { name: 'original.header:', label: m['dashboard.providers.transforms.condition.field.original_header']() },
];

export const getRequestTransformOperators = (): Operator[] => [
  { name: '=', label: m['dashboard.providers.transforms.condition.operator.equals']() },
  { name: '!=', label: m['dashboard.providers.transforms.condition.operator.not_equal']() },
  { name: '>', label: m['dashboard.providers.transforms.condition.operator.greater_than']() },
  { name: '>=', label: m['dashboard.providers.transforms.condition.operator.greater_than_or_equal']() },
  { name: '<', label: m['dashboard.providers.transforms.condition.operator.less_than']() },
  { name: '<=', label: m['dashboard.providers.transforms.condition.operator.less_than_or_equal']() },
  { name: 'in', label: m['dashboard.providers.transforms.condition.operator.in']() },
  { name: 'notIn', label: m['dashboard.providers.transforms.condition.operator.not_in']() },
  { name: 'exists', label: m['dashboard.providers.transforms.condition.operator.exists']() },
  { name: 'doesNotExist', label: m['dashboard.providers.transforms.condition.operator.does_not_exist']() },
  { name: 'pattern', label: m['dashboard.providers.transforms.condition.operator.pattern']() },
  { name: 'regex', label: m['dashboard.providers.transforms.condition.operator.regex']() },
];

export const getRequestTransformCombinators = (): Combinator[] => [
  { name: 'and', label: m['dashboard.providers.transforms.condition.combinator.and']() },
  { name: 'or', label: m['dashboard.providers.transforms.condition.combinator.or']() },
];

export const getRequestTransformTranslations = (): Partial<Translations> => ({
  fields: { title: m['dashboard.providers.transforms.condition.field.title']() },
  operators: { title: m['dashboard.providers.transforms.condition.operator.title']() },
  value: { title: m['dashboard.providers.transforms.condition.value.title']() },
  values: { title: m['dashboard.providers.transforms.condition.value.title']() },
  combinators: { title: m['dashboard.providers.transforms.condition.combinator.title']() },
  valueSourceSelector: { title: m['dashboard.providers.transforms.condition.value_source.title']() },
  notToggle: {
    label: m['dashboard.providers.transforms.condition.action.not'](),
    title: m['dashboard.providers.transforms.condition.action.not_title'](),
  },
  addRule: {
    label: m['dashboard.providers.transforms.condition.action.add_condition'](),
    title: m['dashboard.providers.transforms.condition.action.add_condition'](),
  },
  addGroup: {
    label: m['dashboard.providers.transforms.condition.action.add_group'](),
    title: m['dashboard.providers.transforms.condition.action.add_group'](),
  },
  removeRule: {
    label: m['dashboard.providers.transforms.condition.action.remove_condition'](),
    title: m['dashboard.providers.transforms.condition.action.remove_condition'](),
  },
  removeGroup: {
    label: m['dashboard.providers.transforms.condition.action.remove_group'](),
    title: m['dashboard.providers.transforms.condition.action.remove_group'](),
  },
  shiftActionUp: {
    label: m['dashboard.providers.transforms.condition.action.move_up'](),
    title: m['dashboard.providers.transforms.condition.action.move_up'](),
  },
  shiftActionDown: {
    label: m['dashboard.providers.transforms.condition.action.move_down'](),
    title: m['dashboard.providers.transforms.condition.action.move_down'](),
  },
});

export const getRequestTransformExpressionTranslations = (): Partial<TranslationsExpr> => ({
  exprLhsFunction: { title: m['dashboard.providers.transforms.condition.function.wrap_title']() },
  exprLhsNone: {
    label: m['dashboard.providers.transforms.condition.function.none'](),
    title: m['dashboard.providers.transforms.condition.function.none_title'](),
  },
  valueSourceExpression: {
    label: m['dashboard.providers.transforms.condition.value_source.expression'](),
    title: m['dashboard.providers.transforms.condition.value_source.expression_title'](),
  },
});

export const getRequestTransformAccessibleDescription = (): string =>
  m['dashboard.providers.transforms.condition.editor_title']();

export const getLocalizedRequestTransformFunctionMeta = (): ExpressionFunctionMetaRegistry => ({
  ...requestTransformFunctionMeta,
  add: { ...requestTransformFunctionMeta.add, label: m['dashboard.providers.transforms.condition.function.add']() },
  subtract: {
    ...requestTransformFunctionMeta.subtract,
    label: m['dashboard.providers.transforms.condition.function.subtract'](),
  },
  multiply: {
    ...requestTransformFunctionMeta.multiply,
    label: m['dashboard.providers.transforms.condition.function.multiply'](),
  },
  divide: {
    ...requestTransformFunctionMeta.divide,
    label: m['dashboard.providers.transforms.condition.function.divide'](),
  },
  min: { ...requestTransformFunctionMeta.min, label: m['dashboard.providers.transforms.condition.function.min']() },
  max: { ...requestTransformFunctionMeta.max, label: m['dashboard.providers.transforms.condition.function.max']() },
  abs: { ...requestTransformFunctionMeta.abs, label: m['dashboard.providers.transforms.condition.function.abs']() },
  mod: { ...requestTransformFunctionMeta.mod, label: m['dashboard.providers.transforms.condition.function.mod']() },
  upper: {
    ...requestTransformFunctionMeta.upper,
    label: m['dashboard.providers.transforms.condition.function.upper'](),
  },
  lower: {
    ...requestTransformFunctionMeta.lower,
    label: m['dashboard.providers.transforms.condition.function.lower'](),
  },
  concat: {
    ...requestTransformFunctionMeta.concat,
    label: m['dashboard.providers.transforms.condition.function.concat'](),
  },
  condition: {
    ...requestTransformFunctionMeta.condition,
    label: m['dashboard.providers.transforms.condition.function.condition'](),
  },
  ifNull: {
    ...requestTransformFunctionMeta.ifNull,
    label: m['dashboard.providers.transforms.condition.function.if_null'](),
  },
  concatArrays: {
    ...requestTransformFunctionMeta.concatArrays,
    label: m['dashboard.providers.transforms.condition.function.concat_arrays'](),
  },
  mergeObjects: {
    ...requestTransformFunctionMeta.mergeObjects,
    label: m['dashboard.providers.transforms.condition.function.merge_objects'](),
  },
});

export const getRequestTransformOperatorsForField = (field: string, operators: Operator[]): Operator[] =>
  field.startsWith('request.header:') || field.startsWith('original.header:')
    ? operators.filter((operator) => headerOperatorNames.has(operator.name))
    : operators;

export const getRequestTransformValueSources = (_field: string, operator: string): ValueSources =>
  comparisonOperators.has(operator) ? ['value', 'expression'] : ['value'];

export const allowRequestTransformFunctionsOnLhs = (_field: string, operator: string): boolean =>
  comparisonOperators.has(operator);

const normalizeRule = (rule: DefaultRuleType): DefaultRuleType => {
  const lhs = rule.lhs as ExpressionNode | undefined;
  if (lhs?.kind === 'field') {
    const { lhs: _lhs, ...ruleWithoutLhs } = rule;
    return { ...ruleWithoutLhs, field: lhs.field };
  }
  if (lhs?.kind === 'func' && lhs.args[0]?.kind === 'field') return { ...rule, field: lhs.args[0].field };
  return rule;
};

export const normalizeRequestTransformQuery = (query: DefaultRuleGroupType): DefaultRuleGroupType => ({
  ...query,
  rules: query.rules.map((item) => {
    return 'rules' in item ? normalizeRequestTransformQuery(item) : normalizeRule(item);
  }),
});
