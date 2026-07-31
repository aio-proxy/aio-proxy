import type { ProviderRequestTransformRule, ProviderRequestTransformStage } from '@aio-proxy/types';
import { Query } from 'mingo';

export const MINGO_OPTIONS = { scriptEnabled: false, failOnError: true } as const;

export type CompiledProviderRequestTransformStage = {
  readonly document: ProviderRequestTransformStage;
  readonly stageIndex: number;
  readonly readsBody: boolean;
  readonly writesBody: boolean;
  readonly headerTarget: string | undefined;
};

export type CompiledProviderRequestTransformRule = {
  readonly ruleIndex: number;
  readonly name: string | undefined;
  readonly query: { test(document: Record<string, unknown>): boolean };
  readonly whenReadsBody: boolean;
  readonly stages: readonly CompiledProviderRequestTransformStage[];
};

export type CompiledProviderRequestTransforms = {
  readonly rules: readonly CompiledProviderRequestTransformRule[];
};

export function compileProviderRequestTransforms(
  rules: readonly ProviderRequestTransformRule[],
): CompiledProviderRequestTransforms {
  return {
    rules: rules.map((rule, ruleIndex) => ({
      ruleIndex,
      name: rule.name,
      query: new Query(normalizeMissingFieldComparisons(rule.when ?? {}), MINGO_OPTIONS),
      whenReadsBody: referencesBody(rule.when),
      stages: rule.update.map((stage, stageIndex) => ({
        document: stage,
        stageIndex,
        readsBody: referencesBody(stage),
        writesBody: stageTargetsBody(stage),
        headerTarget: generatedHeaderTarget(stage),
      })),
    })),
  };
}

function referencesBody(value: unknown): boolean {
  if (typeof value === 'string') return bodyReference(value);
  if (Array.isArray(value)) return value.some(referencesBody);
  if (!isDocument(value)) return false;
  return Object.entries(value).some(([key, child]) => key !== '$literal' && (bodyPath(key) || referencesBody(child)));
}

function stageTargetsBody(stage: ProviderRequestTransformStage): boolean {
  const set = stage['$set'];
  if (isDocument(set)) return Object.keys(set).some(bodyPath);
  const unset = stage['$unset'];
  return typeof unset === 'string' && bodyPath(unset);
}

function generatedHeaderTarget(stage: ProviderRequestTransformStage): string | undefined {
  const set = stage['$set'];
  if (!isDocument(set) || !Object.hasOwn(set, 'request.headers')) return undefined;
  const headerUpdate = set['request.headers'];
  if (!isDocument(headerUpdate)) return undefined;
  const operation = headerUpdate['$setField'] ?? headerUpdate['$unsetField'];
  if (!isDocument(operation)) return undefined;
  return typeof operation['field'] === 'string' ? operation['field'] : undefined;
}

function normalizeMissingFieldComparisons(document: Record<string, unknown>): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(document)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      clauses.push({
        [key]: Array.isArray(value)
          ? value.map((child) => (isDocument(child) ? normalizeMissingFieldComparisons(child) : child))
          : value,
      });
      continue;
    }
    clauses.push({ [key]: value });
    if (!key.startsWith('$') && requiresExistingField(value)) clauses.push({ [key]: { $exists: true } });
  }
  if (clauses.length === 0) return {};
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

function requiresExistingField(condition: unknown): boolean {
  if (!isDocument(condition)) return true;
  const operators = Object.keys(condition).filter((key) => key.startsWith('$'));
  return operators.length > 0 && !containsExistsOperator(condition);
}

function containsExistsOperator(condition: Record<string, unknown>): boolean {
  if (Object.hasOwn(condition, '$exists')) return true;
  const not = condition['$not'];
  return isDocument(not) && containsExistsOperator(not);
}

function bodyReference(value: string): boolean {
  return value.startsWith('$') && bodyPath(value.slice(1));
}

function bodyPath(value: string): boolean {
  return ['request.body', 'original.body'].some((root) => value === root || value.startsWith(`${root}.`));
}

function isDocument(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
