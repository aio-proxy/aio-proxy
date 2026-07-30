import { z } from 'zod';

type Json = z.JSONType;
type Document = Record<string, Json>;
type IssuePath = PropertyKey[];

const MongoDocumentSchema = z.record(z.string(), z.json());
const issue = {
  queryOperator: 'REQUEST_TRANSFORM_QUERY_OPERATOR_UNSUPPORTED',
  expressionOperator: 'REQUEST_TRANSFORM_EXPRESSION_OPERATOR_UNSUPPORTED',
  expressionArity: 'REQUEST_TRANSFORM_EXPRESSION_ARITY_INVALID',
  regex: 'REQUEST_TRANSFORM_REGEX_INVALID',
  stage: 'REQUEST_TRANSFORM_STAGE_INVALID',
  target: 'REQUEST_TRANSFORM_TARGET_INVALID',
  path: 'REQUEST_TRANSFORM_PATH_UNSAFE',
  header: 'REQUEST_TRANSFORM_HEADER_INVALID',
} as const;
const expressionArity: Readonly<Record<string, readonly [number, number]>> = {
  $eq: [2, 2],
  $ne: [2, 2],
  $gt: [2, 2],
  $gte: [2, 2],
  $lt: [2, 2],
  $lte: [2, 2],
  $add: [2, 2],
  $subtract: [2, 2],
  $multiply: [2, 2],
  $divide: [2, 2],
  $mod: [2, 2],
  $min: [2, Infinity],
  $max: [2, Infinity],
  $abs: [1, 1],
  $concat: [2, Infinity],
  $toUpper: [1, 1],
  $toLower: [1, 1],
  $cond: [3, 3],
  $ifNull: [2, 2],
  $concatArrays: [2, Infinity],
  $mergeObjects: [2, Infinity],
};
const comparisons = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const logical = new Set(['$and', '$or', '$nor']);
const unsafeSegments = new Set(['__proto__', 'constructor', 'prototype']);
const roots = new Set(['provider', 'request', 'original']);
const headerToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export const ProviderRequestTransformRuleSchema = z.strictObject({
  name: z.string().min(1).optional(),
  when: MongoDocumentSchema.optional(),
  update: z.array(MongoDocumentSchema).min(1),
});
export const ProviderRequestTransformRulesSchema = z
  .array(ProviderRequestTransformRuleSchema)
  .superRefine(validateRules);
export const ProviderTransformsSchema = z.strictObject({ request: ProviderRequestTransformRulesSchema });
export const ProviderRequestTransformRulesJsonSchema = z.toJSONSchema(ProviderRequestTransformRulesSchema, {
  io: 'input',
});

export type ProviderRequestTransformRule = z.output<typeof ProviderRequestTransformRuleSchema>;
export type ProviderRequestTransformStage = ProviderRequestTransformRule['update'][number];
export type ProviderTransforms = z.output<typeof ProviderTransformsSchema>;

function validateRules(rules: readonly ProviderRequestTransformRule[], context: z.RefinementCtx): void {
  for (const [ruleIndex, rule] of rules.entries()) {
    if (rule.when !== undefined) validateQuery(rule.when, [ruleIndex, 'when'], context);
    rule.update.forEach((stage, stageIndex) => validateStage(stage, [ruleIndex, 'update', stageIndex], context));
  }
}

function validateQuery(document: Document, path: IssuePath, context: z.RefinementCtx): void {
  for (const [key, value] of Object.entries(document)) {
    const next = [...path, key];
    if (logical.has(key)) {
      if (!Array.isArray(value) || !value.every(isDocument)) add(context, next, issue.queryOperator);
      else value.forEach((child, index) => validateQuery(child, [...next, index], context));
    } else if (key === '$expr') {
      validateCondition(value, next, context);
    } else if (key.startsWith('$')) {
      add(context, next, issue.queryOperator);
    } else if (!safePath(key) || !roots.has(key.split('.')[0] ?? '')) {
      add(context, next, issue.path);
    } else {
      validateField(value, next, context);
    }
  }
}

function validateField(value: Json, path: IssuePath, context: z.RefinementCtx): void {
  if (!isDocument(value) || !Object.keys(value).some((key) => key.startsWith('$'))) return;
  for (const [operator, operand] of Object.entries(value)) {
    const next = [...path, operator];
    if (comparisons.has(operator)) continue;
    if (operator === '$in' || operator === '$nin') {
      if (!Array.isArray(operand)) add(context, next, issue.queryOperator);
    } else if (operator === '$exists') {
      if (typeof operand !== 'boolean') add(context, next, issue.queryOperator);
    } else if (operator === '$not') {
      if (!isDocument(operand) || !Object.keys(operand).some((key) => key.startsWith('$'))) {
        add(context, next, issue.queryOperator);
      } else validateField(operand, next, context);
    } else if (operator === '$regex') {
      validateRegex(operand, value['$options'], next, [...path, '$options'], context);
    } else if (operator === '$options') {
      if (!Object.hasOwn(value, '$regex')) add(context, next, issue.regex);
    } else add(context, next, issue.queryOperator);
  }
}

function validateCondition(value: Json, path: IssuePath, context: z.RefinementCtx): void {
  if (!isDocument(value) || Object.keys(value).length !== 1) return add(context, path, issue.expressionOperator);
  const [operator, operand] = Object.entries(value)[0]!;
  const next = [...path, operator];
  if (operator === '$regexMatch') return validateRegexMatch(operand, next, context);
  if (!comparisons.has(operator)) return add(context, next, issue.expressionOperator);
  if (!Array.isArray(operand) || operand.length !== 2) return add(context, next, issue.expressionArity);
  if (
    (operator === '$eq' || operator === '$ne') &&
    operand.includes(null) &&
    operand.some((item) => isIfNull(item) || isGetField(item))
  ) {
    return validateHeaderExistence(operand, next, context);
  }
  operand.forEach((item, index) => validateExpression(item, [...next, index], context));
}

function validateExpression(value: Json, path: IssuePath, context: z.RefinementCtx): void {
  if (typeof value === 'string' && value.startsWith('$')) {
    const reference = value.slice(1);
    const supported = ['provider.', 'request.', 'original.'].some((prefix) => reference.startsWith(prefix));
    if (!safePath(reference) || !supported)
      add(context, path, safePath(reference) ? issue.expressionOperator : issue.path);
    return;
  }
  if (Array.isArray(value))
    return value.forEach((child, index) => validateExpression(child, [...path, index], context));
  if (!isDocument(value)) return;
  const entries = Object.entries(value);
  const operators = entries.filter(([key]) => key.startsWith('$'));
  if (operators.length === 0) {
    return entries.forEach(([key, child]) => validateExpression(child, [...path, key], context));
  }
  if (entries.length !== 1) return add(context, path, issue.expressionOperator);
  const [operator, operand] = entries[0]!;
  const next = [...path, operator];
  if (operator === '$literal') return;
  if (operator === '$getField') return validateGetField(operand, next, context);
  const arity = expressionArity[operator];
  if (arity === undefined) return add(context, next, issue.expressionOperator);
  if (!Array.isArray(operand) || operand.length < arity[0] || operand.length > arity[1]) {
    return add(context, next, issue.expressionArity);
  }
  operand.forEach((child, index) => validateExpression(child, [...next, index], context));
}

function validateStage(stage: Document, path: IssuePath, context: z.RefinementCtx): void {
  const entries = Object.entries(stage);
  if (entries.length !== 1) return add(context, path, issue.stage);
  const [operator, operand] = entries[0]!;
  const next = [...path, operator];
  if (operator === '$unset') {
    if (typeof operand !== 'string') return add(context, next, issue.stage);
    if (!safePath(operand)) return add(context, next, issue.path);
    if (!bodyTarget(operand)) add(context, next, issue.target);
    return;
  }
  if (operator !== '$set') return add(context, next, issue.stage);
  if (!isDocument(operand) || Object.keys(operand).length !== 1) return add(context, next, issue.stage);
  const [target, value] = Object.entries(operand)[0]!;
  if (!safePath(target)) return add(context, next, issue.path);
  if (target === 'request.headers') return validateHeaderUpdate(value, next, context);
  if (!bodyTarget(target)) return add(context, next, issue.target);
  validateExpression(value, [...next, target], context);
}

function validateHeaderUpdate(value: Json, path: IssuePath, context: z.RefinementCtx): void {
  if (!isDocument(value) || Object.keys(value).length !== 1) return add(context, path, issue.header);
  const set = value['$setField'];
  const unset = value['$unsetField'];
  const operation = set ?? unset;
  const keys = set === undefined ? ['field', 'input'] : ['field', 'input', 'value'];
  const operator = set === undefined ? '$unsetField' : '$setField';
  if (!isDocument(operation) || !exactKeys(operation, keys)) return add(context, [...path, operator], issue.header);
  validateHeaderName(operation['field'], [...path, operator, 'field'], context);
  if (operation['input'] !== '$request.headers') add(context, [...path, operator, 'input'], issue.header);
  if (set !== undefined) validateExpression(operation['value']!, [...path, operator, 'value'], context);
}

function validateGetField(value: Json, path: IssuePath, context: z.RefinementCtx): void {
  if (!isDocument(value) || !exactKeys(value, ['field', 'input'])) return add(context, path, issue.header);
  validateHeaderName(value['field'], [...path, 'field'], context);
  if (value['input'] !== '$request.headers' && value['input'] !== '$original.headers') {
    add(context, [...path, 'input'], issue.header);
  }
}

function validateRegexMatch(value: Json, path: IssuePath, context: z.RefinementCtx): void {
  const keys =
    isDocument(value) && Object.hasOwn(value, 'options') ? ['input', 'regex', 'options'] : ['input', 'regex'];
  if (!isDocument(value) || !exactKeys(value, keys)) return add(context, path, issue.header);
  if (!isGetField(value['input'])) add(context, [...path, 'input'], issue.header);
  else validateExpression(value['input'], [...path, 'input'], context);
  validateRegex(value['regex'], value['options'], [...path, 'regex'], [...path, 'options'], context);
}

function validateHeaderExistence(operands: readonly Json[], path: IssuePath, context: z.RefinementCtx): void {
  const expression = operands.find(isIfNull);
  const args = expression?.['$ifNull'];
  if (
    operands.filter((value) => value === null).length !== 1 ||
    !Array.isArray(args) ||
    args.length !== 2 ||
    !isGetField(args[0]) ||
    args[1] !== null
  )
    return add(context, path, issue.header);
  validateExpression(args[0], [...path, operands.indexOf(expression!), '$ifNull', 0], context);
}

function validateRegex(
  pattern: Json | undefined,
  options: Json | undefined,
  patternPath: IssuePath,
  optionsPath: IssuePath,
  context: z.RefinementCtx,
): void {
  if (typeof pattern !== 'string') return add(context, patternPath, issue.regex);
  if (options !== undefined && (typeof options !== 'string' || !/^(?!.*(.).*\1)[imsu]*$/u.test(options))) {
    return add(context, optionsPath, issue.regex);
  }
  try {
    new RegExp(pattern, options);
  } catch {
    add(context, patternPath, issue.regex);
  }
}

function validateHeaderName(value: Json | undefined, path: IssuePath, context: z.RefinementCtx): void {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !headerToken.test(value)) {
    add(context, path, issue.header);
  }
}

function isDocument(value: Json | undefined): value is Document {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isGetField(value: Json | undefined): value is Record<'$getField', Json> {
  return isDocument(value) && exactKeys(value, ['$getField']);
}
function isIfNull(value: Json): value is Record<'$ifNull', Json> {
  return isDocument(value) && exactKeys(value, ['$ifNull']);
}
function exactKeys(document: Document, keys: readonly string[]): boolean {
  return Object.keys(document).length === keys.length && keys.every((key) => Object.hasOwn(document, key));
}
function safePath(path: string): boolean {
  return path.split('.').every((segment) => segment !== '' && !unsafeSegments.has(segment));
}
function bodyTarget(path: string): boolean {
  return path === 'request.body' || path.startsWith('request.body.');
}
function add(context: z.RefinementCtx, path: IssuePath, message: (typeof issue)[keyof typeof issue]): void {
  context.addIssue({ code: 'custom', path, message });
}
