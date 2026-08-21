import type { ExpressionNode } from '@react-querybuilder/expr';

import { requestTransformFunctionMeta } from '../mongo-codec';

// Arithmetic reads as `a + b`, not `+(a, b)`; every other function keeps call syntax.
const infixExpressionFunctions: Record<string, string> = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '÷',
  mod: '%',
};

const expressionFieldPreview = (field: string): string => {
  const separator = field.indexOf(':');
  if (separator === -1) return field;
  const scope = field.slice(0, separator);
  const suffix = field.slice(separator + 1);
  return scope.endsWith('.header')
    ? `${scope}[${JSON.stringify(suffix)}]`
    : suffix === ''
      ? scope
      : `${scope}.${suffix}`;
};

const formatExpressionNode = (node: ExpressionNode, nested: boolean): string => {
  if (node.kind === 'field') return expressionFieldPreview(node.field);
  if (node.kind === 'parameter') return `$${node.parameter}`;
  if (node.kind === 'value') return JSON.stringify(node.value) ?? String(node.value);

  const infix = infixExpressionFunctions[node.fn];
  if (infix !== undefined) {
    const expression = node.args.map((argument) => formatExpressionNode(argument, true)).join(` ${infix} `);
    return nested ? `(${expression})` : expression;
  }

  const label = requestTransformFunctionMeta[node.fn as keyof typeof requestTransformFunctionMeta]?.label ?? node.fn;
  return `${label}(${node.args.map((argument) => formatExpressionNode(argument, false)).join(', ')})`;
};

export const formatRequestTransformExpression = (node: ExpressionNode): string => formatExpressionNode(node, false);
