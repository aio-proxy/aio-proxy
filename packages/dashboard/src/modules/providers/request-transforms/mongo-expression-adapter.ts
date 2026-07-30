import type {
  ExpressionFunctionMetaRegistry,
  ExpressionNode,
  MongoAggSerializerRegistry,
} from '@react-querybuilder/expr';
import type { RuleProcessor, RuleType } from 'react-querybuilder';

type ParserContext = { readonly fieldExists: (field: string) => boolean };
type Serializer = MongoAggSerializerRegistry[string];
type Document = Record<string, unknown>;
export type HeaderScope = 'request' | 'original';
const HEADER_PREFIX = '__aio_header__:';

// Adapted from @react-querybuilder/expr 8.21.2 (MIT); its root entry eagerly imports unrelated optional engines.
export const mongoFunctionMeta = {
  add: { label: '+', arity: 2 },
  subtract: { label: '-', arity: 2 },
  multiply: { label: '×', arity: 2 },
  divide: { label: '÷', arity: 2 },
  min: { label: 'MIN', arity: [2, Infinity] },
  max: { label: 'MAX', arity: [2, Infinity] },
  abs: { label: 'ABS', arity: 1 },
  mod: { label: 'MOD', arity: 2 },
  upper: { label: 'UPPER', arity: 1 },
  lower: { label: 'LOWER', arity: 1 },
} satisfies ExpressionFunctionMetaRegistry;

export const mongoSerializers = {
  add: (_options, a, b) => ({ $add: [a, b] }),
  subtract: (_options, a, b) => ({ $subtract: [a, b] }),
  multiply: (_options, a, b) => ({ $multiply: [a, b] }),
  divide: (_options, a, b) => ({ $divide: [a, b] }),
  min: (_options, ...args) => ({ $min: args }),
  max: (_options, ...args) => ({ $max: args }),
  abs: (_options, value) => ({ $abs: value }),
  mod: (_options, a, b) => ({ $mod: [a, b] }),
  upper: (_options, value) => ({ $toUpper: value }),
  lower: (_options, value) => ({ $toLower: value }),
} satisfies MongoAggSerializerRegistry;

const mongoInverse: Record<string, string> = {
  $add: 'add',
  $subtract: 'subtract',
  $multiply: 'multiply',
  $divide: 'divide',
  $min: 'min',
  $max: 'max',
  $abs: 'abs',
  $mod: 'mod',
  $toUpper: 'upper',
  $toLower: 'lower',
};

const isDocument = (value: unknown): value is Document =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const validArity = (node: ExpressionNode, meta: ExpressionFunctionMetaRegistry): boolean => {
  if (node.kind !== 'func') return node.kind !== 'field' || node.field !== '';
  const arity = meta[node.fn]?.arity;
  const valid =
    arity === undefined
      ? true
      : typeof arity === 'number'
        ? node.args.length === arity
        : node.args.length >= arity[0] && node.args.length <= arity[1];
  return valid && node.args.every((argument) => validArity(argument, meta));
};

export const createMongoExpressionParser = (
  customInverse: Record<string, string>,
  customMeta: ExpressionFunctionMetaRegistry,
) => {
  const inverse = { ...mongoInverse, ...customInverse };
  const meta = { ...mongoFunctionMeta, ...customMeta };
  return (value: unknown, context: ParserContext): ExpressionNode | null => {
    const build = (node: unknown): ExpressionNode | null => {
      if (typeof node === 'string' && node.startsWith('$')) {
        const field = node.slice(1);
        return context.fieldExists(field) ? { kind: 'field', field } : null;
      }
      if (!isDocument(node)) return { kind: 'value', value: node };
      const [operator, payload] = Object.entries(node)[0] ?? [];
      if (operator === undefined) return null;
      if (['$abs', '$toUpper', '$toLower'].includes(operator) && !Array.isArray(payload)) return null;
      const args: ExpressionNode[] = [];
      for (const item of Array.isArray(payload) ? payload : [payload]) {
        const argument = build(item);
        if (argument === null) return null;
        args.push(argument);
      }
      return { kind: 'func', fn: inverse[operator] ?? operator, args };
    };
    const result = build(value);
    return result !== null && validArity(result, meta) && (result.kind !== 'func' || result.fn in meta) ? result : null;
  };
};

export const serializeMongoExpression = (node: ExpressionNode, serializers: MongoAggSerializerRegistry): unknown => {
  if (node.kind === 'field') return `$${node.field}`;
  if (node.kind === 'parameter') return node.parameter;
  if (node.kind === 'value') return node.value;
  const serializer: Serializer | undefined = serializers[node.fn];
  if (serializer === undefined) throw new Error(`Unsupported request transform function: ${node.fn}`);
  const args = node.args.map((argument) => serializeMongoExpression(argument, serializers));
  return typeof serializer === 'function' ? serializer({}, ...args) : { [serializer]: args };
};

const comparison = { '=': '$eq', '!=': '$ne', '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' } as const;

const basicRule = (rule: RuleType): unknown => {
  if (rule.valueSource === 'field' && rule.operator in comparison) {
    return { $expr: { [comparison[rule.operator as keyof typeof comparison]]: [`$${rule.field}`, `$${rule.value}`] } };
  }
  if (rule.operator === '=') return { [rule.field]: rule.value };
  if (rule.operator in comparison) {
    return { [rule.field]: { [comparison[rule.operator as keyof typeof comparison]]: rule.value } };
  }
  if (rule.operator === 'in' || rule.operator === 'notIn') {
    return { [rule.field]: { [rule.operator === 'in' ? '$in' : '$nin']: rule.value } };
  }
  if (rule.operator === 'null') return { [rule.field]: null };
  if (rule.operator === 'notNull') return { [rule.field]: { $ne: null } };
  return '';
};

export const createMongoExpressionRuleProcessor =
  (serializers: MongoAggSerializerRegistry): RuleProcessor =>
  (rule) => {
    const lhs = rule.lhs as ExpressionNode | undefined;
    const rhs = rule.valueSource === 'expression' ? (rule.value as ExpressionNode) : undefined;
    if (lhs === undefined && rhs === undefined) return basicRule(rule);
    if (!(rule.operator in comparison)) return '';
    const left = lhs === undefined ? `$${rule.field}` : serializeMongoExpression(lhs, serializers);
    const right = rhs === undefined ? rule.value : serializeMongoExpression(rhs, serializers);
    return { $expr: { [comparison[rule.operator as keyof typeof comparison]]: [left, right] } };
  };

export const headerSentinel = (scope: HeaderScope, name: string): string =>
  `${HEADER_PREFIX}${scope}:${encodeURIComponent(name)}`;

export const parseHeaderSentinel = (field: string): { scope: HeaderScope; name: string } | undefined => {
  if (!field.startsWith(HEADER_PREFIX)) return undefined;
  const [scope, encoded] = field.slice(HEADER_PREFIX.length).split(':', 2);
  if ((scope !== 'request' && scope !== 'original') || encoded === undefined) return undefined;
  return { scope, name: decodeURIComponent(encoded) };
};

export const mongoHeaderGetField = (scope: HeaderScope, name: string): Document => ({
  $getField: { field: name, input: `$${scope}.headers` },
});

export const normalizeMongoRegexOptions = (options: unknown): string =>
  [...new Set(typeof options === 'string' ? options : '')]
    .filter((flag) => 'imsu'.includes(flag))
    .sort((a, b) => 'imsu'.indexOf(a) - 'imsu'.indexOf(b))
    .join('');

export const replaceMongoHeaderReferences = (value: unknown): unknown => {
  if (typeof value === 'string' && value.startsWith(`$${HEADER_PREFIX}`)) {
    const header = parseHeaderSentinel(value.slice(1));
    return header === undefined ? value : mongoHeaderGetField(header.scope, header.name);
  }
  if (Array.isArray(value)) return value.map(replaceMongoHeaderReferences);
  if (!isDocument(value)) return value;
  const entries = Object.entries(value);
  if (
    entries.length === 1 &&
    Array.isArray(value['$nor']) &&
    value['$nor'].length === 1 &&
    isDocument(value['$nor'][0]) &&
    Array.isArray(value['$nor'][0]['$or'])
  ) {
    return { $nor: value['$nor'][0]['$or'].map(replaceMongoHeaderReferences) };
  }
  if (entries.length === 1) {
    const [field, condition] = entries[0]!;
    const header = parseHeaderSentinel(field);
    if (header !== undefined) {
      const input = mongoHeaderGetField(header.scope, header.name);
      if (isDocument(condition) && typeof condition['$exists'] === 'boolean') {
        return { $expr: { [condition['$exists'] ? '$ne' : '$eq']: [{ $ifNull: [input, null] }, null] } };
      }
      if (isDocument(condition) && typeof condition['$regex'] === 'string') {
        return {
          $expr: {
            $regexMatch: {
              input,
              regex: condition['$regex'],
              options: normalizeMongoRegexOptions(condition['$options']),
            },
          },
        };
      }
      if (isDocument(condition) && Object.keys(condition).length === 1) {
        const [operator, operand] = Object.entries(condition)[0]!;
        return { $expr: { [operator]: [input, replaceMongoHeaderReferences(operand)] } };
      }
      return { $expr: { $eq: [input, replaceMongoHeaderReferences(condition)] } };
    }
  }
  return Object.fromEntries(entries.map(([key, child]) => [key, replaceMongoHeaderReferences(child)]));
};
