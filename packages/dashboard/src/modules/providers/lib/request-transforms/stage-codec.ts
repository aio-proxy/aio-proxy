import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { ProviderRequestTransformRulesSchema, type ProviderRequestTransformStage } from '@aio-proxy/types';
import type { ExpressionNode } from '@react-querybuilder/expr';
import { z } from 'zod';

import { parseRequestTransformExpression, serializeRequestTransformExpression } from './mongo-codec';

export type RequestTransformStageDraft =
  | {
      readonly kind: 'set';
      readonly target: 'body' | 'header';
      readonly path: string;
      readonly value:
        | { readonly kind: 'static'; readonly value: JsonValue }
        | { readonly kind: 'expression'; readonly expression: ExpressionNode };
    }
  | {
      readonly kind: 'remove';
      readonly target: 'body' | 'header';
      readonly path: string;
    };

type Document = Record<string, unknown>;
const isDocument = (value: unknown): value is Document =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Document, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const parseValue = (value: unknown): Extract<RequestTransformStageDraft, { kind: 'set' }>['value'] => {
  if (isDocument(value) && exactKeys(value, ['$literal'])) {
    return { kind: 'static', value: value['$literal'] as JsonValue };
  }
  if (Array.isArray(value) || (isDocument(value) && Object.keys(value).some((key) => !key.startsWith('$')))) {
    throw new Error('Non-canonical request transform value');
  }
  if (!Array.isArray(value) && !isDocument(value) && !(typeof value === 'string' && value.startsWith('$'))) {
    return { kind: 'static', value: value as JsonValue };
  }
  return { kind: 'expression', expression: parseRequestTransformExpression(value) };
};

const bodyPath = (target: string): string | undefined => {
  if (target === 'request.body') return undefined;
  return target.startsWith('request.body.') ? target.slice('request.body.'.length) : undefined;
};

export const parseRequestTransformStages = (
  stages: readonly ProviderRequestTransformStage[],
): RequestTransformStageDraft[] => {
  ProviderRequestTransformRulesSchema.parse([{ update: stages }]);
  return stages.map((stage) => {
    if ('$unset' in stage) {
      const path = bodyPath(stage['$unset'] as string);
      if (path === undefined) throw new Error('Non-canonical request transform stage');
      return { kind: 'remove', target: 'body', path };
    }
    if (!('$set' in stage) || !isDocument(stage['$set']) || Object.keys(stage['$set']).length !== 1) {
      throw new Error('Non-canonical request transform stage');
    }
    const [target, value] = Object.entries(stage['$set'])[0]!;
    const path = bodyPath(target);
    if (path !== undefined) return { kind: 'set', target: 'body', path, value: parseValue(value) };
    if (target !== 'request.headers' || !isDocument(value) || Object.keys(value).length !== 1) {
      throw new Error('Non-canonical request transform stage');
    }
    if (isDocument(value['$unsetField']) && exactKeys(value['$unsetField'], ['field', 'input'])) {
      return { kind: 'remove', target: 'header', path: value['$unsetField']['field'] as string };
    }
    if (isDocument(value['$setField']) && exactKeys(value['$setField'], ['field', 'input', 'value'])) {
      return {
        kind: 'set',
        target: 'header',
        path: value['$setField']['field'] as string,
        value: parseValue(value['$setField']['value']),
      };
    }
    throw new Error('Non-canonical request transform stage');
  });
};

const staticExpression = (value: JsonValue): JsonValue =>
  Array.isArray(value) ||
  (typeof value === 'object' && value !== null) ||
  (typeof value === 'string' && value.startsWith('$'))
    ? { $literal: value }
    : value;

const stageDocument = z.record(z.string(), z.json());
const stage = (value: unknown): ProviderRequestTransformStage => stageDocument.parse(value);

export const serializeRequestTransformStages = (
  drafts: readonly RequestTransformStageDraft[],
): ProviderRequestTransformStage[] =>
  drafts.map((draft) => {
    if (draft.kind === 'remove') {
      return draft.target === 'body'
        ? stage({ $unset: `request.body.${draft.path}` })
        : stage({
            $set: {
              'request.headers': {
                $unsetField: { field: draft.path, input: '$request.headers' },
              },
            },
          });
    }
    const value =
      draft.value.kind === 'static'
        ? staticExpression(draft.value.value)
        : serializeRequestTransformExpression(draft.value.expression);
    return draft.target === 'body'
      ? stage({ $set: { [`request.body.${draft.path}`]: value } })
      : stage({
          $set: {
            'request.headers': {
              $setField: { field: draft.path, input: '$request.headers', value },
            },
          },
        });
  });
