import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { formatQuery } from '@react-querybuilder/core/formatQuery';
import { parseMongoDB } from '@react-querybuilder/core/parseMongoDB';
import type {
  ExpressionFunctionMetaRegistry,
  ExpressionNode,
  MongoAggSerializerRegistry,
} from '@react-querybuilder/expr';
import type { DefaultRuleGroupType, RuleProcessor, RuleType } from 'react-querybuilder';

import {
  createMongoExpressionParser,
  createMongoExpressionRuleProcessor,
  headerSentinel,
  mongoFunctionMeta,
  mongoSerializers,
  normalizeMongoRegexOptions,
  parseHeaderSentinel,
  replaceMongoHeaderReferences,
  serializeMongoExpression,
  type HeaderScope,
} from './mongo-expression-adapter';
import { patternToRegex, regexToPattern } from './pattern';

type Condition = NonNullable<ProviderRequestTransformRule['when']>;
type Document = Record<string, unknown>;
export const requestTransformFunctionMeta = {
  ...mongoFunctionMeta,
  concat: { label: 'CONCAT', arity: [2, Infinity] },
  condition: { label: 'IF', arity: 3 },
  ifNull: { label: 'IF NULL', arity: 2 },
  concatArrays: { label: 'CONCAT ARRAYS', arity: [2, Infinity] },
  mergeObjects: { label: 'MERGE OBJECTS', arity: [2, Infinity] },
} satisfies ExpressionFunctionMetaRegistry;
export const requestTransformMongoSerializers = {
  ...mongoSerializers,
  abs: (_options, value) => ({ $abs: [value] }),
  upper: (_options, value) => ({ $toUpper: [value] }),
  lower: (_options, value) => ({ $toLower: [value] }),
  concat: '$concat',
  condition: '$cond',
  ifNull: '$ifNull',
  concatArrays: '$concatArrays',
  mergeObjects: '$mergeObjects',
} satisfies MongoAggSerializerRegistry;
export const requestTransformMongoInverse = {
  $concat: 'concat',
  $cond: 'condition',
  $ifNull: 'ifNull',
  $concatArrays: 'concatArrays',
  $mergeObjects: 'mergeObjects',
};
const privateSerializers = {
  ...requestTransformMongoSerializers,
  __literal: (_options: unknown, value: unknown) => ({ $literal: value }),
} satisfies MongoAggSerializerRegistry;
const parserInverse = { ...requestTransformMongoInverse, $literal: '__literal' };
const parserMeta = { ...requestTransformFunctionMeta, __literal: { arity: 1 } };
const parseExpression = createMongoExpressionParser(parserInverse, parserMeta);
const baseRuleProcessor = createMongoExpressionRuleProcessor(privateSerializers);
const LITERAL_PREFIX = '__aio_literal__:';
const isDocument = (value: unknown): value is Document =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Document, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const readGetField = (value: unknown): { scope: HeaderScope; name: string } | undefined => {
  if (!isDocument(value) || !exactKeys(value, ['$getField']) || !isDocument(value['$getField'])) return undefined;
  const operation = value['$getField'];
  if (!exactKeys(operation, ['field', 'input']) || typeof operation['field'] !== 'string') return undefined;
  const scope =
    operation['input'] === '$request.headers'
      ? 'request'
      : operation['input'] === '$original.headers'
        ? 'original'
        : undefined;
  return scope === undefined ? undefined : { scope, name: operation['field'] };
};
const toUiField = (field: string): string => {
  const header = parseHeaderSentinel(field);
  if (header !== undefined) return `${header.scope}.header:${header.name}`;
  for (const scope of ['request', 'original'] as const) {
    const prefix = `${scope}.body.`;
    if (field.startsWith(prefix)) return `${scope}.body:${field.slice(prefix.length)}`;
  }
  return field;
};
const toMongoField = (field: string): string => {
  for (const scope of ['request', 'original'] as const) {
    const body = `${scope}.body:`;
    const header = `${scope}.header:`;
    if (field.startsWith(body)) return `${scope}.body.${field.slice(body.length)}`;
    if (field.startsWith(header)) return headerSentinel(scope, field.slice(header.length));
  }
  return field;
};
const mapExpression = (node: ExpressionNode, field: (value: string) => string): ExpressionNode =>
  node.kind === 'field'
    ? { ...node, field: field(node.field) }
    : node.kind === 'func'
      ? { ...node, args: node.args.map((argument) => mapExpression(argument, field)) }
      : node;
const unwrapLiterals = (node: ExpressionNode, literals: Map<string, unknown>): ExpressionNode => {
  if (node.kind !== 'func') return node.kind === 'field' ? { ...node, field: toUiField(node.field) } : node;
  if (node.fn === '__literal' && node.args.length === 1 && node.args[0]?.kind === 'value') {
    return { kind: 'value', value: literals.get(String(node.args[0].value)) };
  }
  return { ...node, args: node.args.map((argument) => unwrapLiterals(argument, literals)) };
};
const requiresLiteral = (value: unknown): boolean =>
  Array.isArray(value) || isDocument(value) || (typeof value === 'string' && value.startsWith('$'));

const prepareExpressionForExport = (node: ExpressionNode): ExpressionNode => {
  const mapped = mapExpression(node, toMongoField);
  if (mapped.kind === 'value' && requiresLiteral(mapped.value)) {
    return { kind: 'func', fn: '__literal', args: [{ kind: 'value', value: mapped.value }] };
  }
  if (mapped.kind === 'func') return { ...mapped, args: mapped.args.map(prepareExpressionForExport) };
  return mapped;
};
const prepareExpressionInput = (value: unknown, literals: Map<string, unknown>): unknown => {
  const header = readGetField(value);
  if (header !== undefined) return `$${headerSentinel(header.scope, header.name)}`;
  if (Array.isArray(value)) return value.map((item) => prepareExpressionInput(item, literals));
  if (!isDocument(value)) return value;
  if (exactKeys(value, ['$literal'])) {
    const token = `${LITERAL_PREFIX}${literals.size}`;
    literals.set(token, value['$literal']);
    return { $literal: token };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, prepareExpressionInput(child, literals)]),
  );
};
export const parseRequestTransformExpression = (value: unknown): ExpressionNode => {
  const literals = new Map<string, unknown>();
  const node = parseExpression(prepareExpressionInput(value, literals), { fieldExists: () => true });
  if (node === null) throw new Error('Unsupported request transform expression');
  return unwrapLiterals(node, literals);
};
export const serializeRequestTransformExpression = (node: ExpressionNode): unknown =>
  replaceMongoHeaderReferences(serializeMongoExpression(prepareExpressionForExport(node), privateSerializers));
const mongoComparison = { $eq: '=', $ne: '!=', $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' } as const;
const rewriteHeaderExpressionCondition = (expression: unknown): Document | undefined => {
  if (!isDocument(expression) || Object.keys(expression).length !== 1) return undefined;
  if (isDocument(expression['$regexMatch'])) {
    const match = expression['$regexMatch'];
    const header = readGetField(match['input']);
    if (header !== undefined && typeof match['regex'] === 'string') {
      return {
        [headerSentinel(header.scope, header.name)]: {
          $__aioRegex: { regex: match['regex'], options: match['options'] ?? '' },
        },
      };
    }
  }
  const [operator, operands] = Object.entries(expression)[0]!;
  if (
    !['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'].includes(operator) ||
    !Array.isArray(operands) ||
    operands.length !== 2
  )
    return undefined;
  const first = readGetField(operands[0]);
  if (first !== undefined) return { [headerSentinel(first.scope, first.name)]: { [operator]: operands[1] } };
  const ifNull = isDocument(operands[0]) && Array.isArray(operands[0]['$ifNull']) ? operands[0]['$ifNull'] : undefined;
  const existsHeader = ifNull?.length === 2 && ifNull[1] === null ? readGetField(ifNull[0]) : undefined;
  if (existsHeader !== undefined && operands[1] === null && (operator === '$eq' || operator === '$ne')) {
    return { [headerSentinel(existsHeader.scope, existsHeader.name)]: { $__aioExists: operator === '$ne' } };
  }
  return undefined;
};
const rewriteConditionInput = (value: unknown, literals: Map<string, unknown>): unknown => {
  if (Array.isArray(value)) return value.map((item) => rewriteConditionInput(item, literals));
  if (!isDocument(value)) return value;
  if (Object.hasOwn(value, '$expr')) {
    const header = rewriteHeaderExpressionCondition(value['$expr']);
    if (header !== undefined) return header;
    const expression = value['$expr'];
    if (isDocument(expression)) {
      const [operator, operands] = Object.entries(expression)[0] ?? [];
      if (operator !== undefined && operator in mongoComparison && Array.isArray(operands) && operands.length === 2) {
        return {
          __aio_expression__: {
            $__aioExpression: {
              operator: mongoComparison[operator as keyof typeof mongoComparison],
              lhs: prepareExpressionInput(operands[0], literals),
              rhs: prepareExpressionInput(operands[1], literals),
            },
          },
        };
      }
    }
    return { $expr: prepareExpressionInput(expression, literals) };
  }
  const result: Document = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$nor') result['$not'] = { $or: rewriteConditionInput(child, literals) };
    else if (key.startsWith('$')) result[key] = rewriteConditionInput(child, literals);
    else if (isDocument(child) && typeof child['$regex'] === 'string') {
      const optionsPresent = Object.hasOwn(child, '$options');
      const pattern = optionsPresent ? undefined : regexToPattern(child['$regex']);
      result[key] =
        pattern === undefined
          ? { $__aioRegex: { regex: child['$regex'], options: child['$options'] ?? '' } }
          : { $__aioPattern: pattern };
    } else if (isDocument(child) && typeof child['$exists'] === 'boolean') {
      result[key] = { $__aioExists: child['$exists'] };
    } else result[key] = rewriteConditionInput(child, literals);
  }
  return result;
};
const additionalOperators = (literals: Map<string, unknown>) => ({
  $__aioPattern: (field: string, _operator: string, value: unknown): RuleType => ({
    field,
    operator: 'pattern',
    value,
  }),
  $__aioRegex: (field: string, _operator: string, value: unknown): RuleType => ({ field, operator: 'regex', value }),
  $__aioExists: (field: string, _operator: string, value: unknown): RuleType => ({
    field,
    operator: value ? 'exists' : 'doesNotExist',
    value: null,
  }),
  $__aioExpression: (_field: string, _operator: string, value: unknown): RuleType => {
    if (!isDocument(value) || typeof value['operator'] !== 'string')
      throw new Error('Unsupported condition expression');
    const context = { fieldExists: () => true };
    const lhs = parseExpression(value['lhs'], context);
    const rhs = parseExpression(value['rhs'], context);
    if (lhs === null || rhs === null) throw new Error('Unsupported condition expression');
    return {
      field: '',
      operator: value['operator'],
      lhs: unwrapLiterals(lhs, literals),
      value: unwrapLiterals(rhs, literals),
      valueSource: 'expression',
    };
  },
});
const mapQuery = (
  query: DefaultRuleGroupType,
  field: (value: string) => string,
  literals?: Map<string, unknown>,
): DefaultRuleGroupType => ({
  ...query,
  rules: query.rules.map((item) => {
    if ('rules' in item) return mapQuery(item, field, literals);
    const rule = { ...item, field: field(item.field) };
    if (rule.lhs) rule.lhs = literals ? unwrapLiterals(rule.lhs, literals) : prepareExpressionForExport(rule.lhs);
    if (rule.valueSource === 'expression') {
      rule.value = Array.isArray(rule.value)
        ? rule.value.map((node) => (literals ? unwrapLiterals(node, literals) : prepareExpressionForExport(node)))
        : literals
          ? unwrapLiterals(rule.value, literals)
          : prepareExpressionForExport(rule.value);
    }
    return rule;
  }),
});
export const parseRequestTransformCondition = (when: Condition): DefaultRuleGroupType => {
  const literals = new Map<string, unknown>();
  const query = parseMongoDB(rewriteConditionInput(when, literals) as Document, {
    additionalOperators: additionalOperators(literals),
    getExpression: parseExpression,
    listsAsArrays: true,
  });
  return mapQuery(query, toUiField, literals);
};
const ruleProcessor: RuleProcessor = (rule, options) => {
  if (rule.operator === 'pattern') return { [rule.field]: { $regex: patternToRegex(String(rule.value)) } };
  if (rule.operator === 'regex') {
    const value = isDocument(rule.value) ? rule.value : {};
    return {
      [rule.field]: {
        $regex: typeof value['regex'] === 'string' ? value['regex'] : '',
        $options: normalizeMongoRegexOptions(value['options']),
      },
    };
  }
  if (rule.operator === 'exists' || rule.operator === 'doesNotExist') {
    return { [rule.field]: { $exists: rule.operator === 'exists' } };
  }
  return baseRuleProcessor(rule, options);
};
export const serializeRequestTransformCondition = (query: DefaultRuleGroupType): Condition =>
  (query.rules.length === 0
    ? {}
    : replaceMongoHeaderReferences(
        formatQuery(mapQuery(query, toMongoField), { format: 'mongodb_query', ruleProcessor }),
      )) as Condition;
