import { digestProviderEntry } from '@aio-proxy/core';
import type { DashboardRoutingModelMutation } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

export class ModelRoutingStaleRevisionError extends Error {
  constructor() {
    super('stale_revision');
    this.name = 'ModelRoutingStaleRevisionError';
  }
}

export function applyRoutingMutation(
  current: Record<string, unknown>,
  input: DashboardRoutingModelMutation,
): Record<string, unknown> {
  const currentPolicy = readRawModelPolicy(current, input.modelId);
  if (digestProviderEntry(currentPolicy ?? null) !== input.revision) {
    throw new ModelRoutingStaleRevisionError();
  }
  const preserved = Object.fromEntries(
    Object.entries(rawPolicyProviders(currentPolicy)).filter(([id]) => !input.baselineProviderIds.includes(id)),
  );
  const currentProviders = rawPolicyProviders(currentPolicy);
  const submitted = Object.fromEntries(
    Object.entries(input.providers)
      .map(([id, value]) => [id, mergeProviderOverride(currentProviders[id], value)] as const)
      .filter(([, value]) => Object.keys(value).length > 0),
  );
  return writeRawModelPolicy(current, input.modelId, { ...preserved, ...submitted }, input.metadata);
}

export function readRawModelPolicy(current: Record<string, unknown>, modelId: string): unknown {
  const router = current['router'];
  if (!isPlainObject(router)) return undefined;
  const models = router['models'];
  if (!isPlainObject(models)) return undefined;
  return Object.hasOwn(models, modelId) ? models[modelId] : undefined;
}

export function rawModelPolicySlugs(current: Readonly<Record<string, unknown>>): readonly string[] {
  const router = current['router'];
  if (!isPlainObject(router)) return [];
  const models = router['models'];
  return isPlainObject(models) ? Object.keys(models) : [];
}

export function writeRawModelPolicy(
  current: Record<string, unknown>,
  modelId: string,
  providers: Readonly<Record<string, unknown>>,
  metadata?: DashboardRoutingModelMutation['metadata'],
): Record<string, unknown> {
  const currentRouter = isPlainObject(current['router']) ? current['router'] : {};
  const currentModels = isPlainObject(currentRouter['models']) ? { ...currentRouter['models'] } : {};
  const currentPolicy = isPlainObject(currentModels[modelId]) ? currentModels[modelId] : {};
  const { providers: _ignored, ...futurePolicyFields } = currentPolicy;
  if (metadata === null) delete futurePolicyFields['metadata'];
  else if (metadata !== undefined) futurePolicyFields['metadata'] = metadata;
  const hasProviders = Object.keys(providers).length > 0;
  const hasFuturePolicy = Object.keys(futurePolicyFields).length > 0;

  if (!hasProviders && !hasFuturePolicy) delete currentModels[modelId];
  else {
    Object.defineProperty(currentModels, modelId, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        ...futurePolicyFields,
        ...(hasProviders ? { providers } : {}),
      },
    });
  }

  const { models: _models, ...futureRouterFields } = currentRouter;
  const hasModels = Object.keys(currentModels).length > 0;
  const hasFutureRouter = Object.keys(futureRouterFields).length > 0;
  if (!hasModels && !hasFutureRouter) {
    const { router: _router, ...rest } = current;
    return rest;
  }
  return {
    ...current,
    router: {
      ...futureRouterFields,
      ...(hasModels ? { models: currentModels } : {}),
    },
  };
}

export function rawPolicyProviders(policy: unknown): Record<string, unknown> {
  if (!isPlainObject(policy)) return {};
  return isPlainObject(policy['providers']) ? policy['providers'] : {};
}

function mergeProviderOverride(
  existingRaw: unknown,
  submitted: DashboardRoutingModelMutation['providers'][string],
): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(existingRaw) ? { ...existingRaw } : {};
  delete base['priority'];
  delete base['weight'];
  if (submitted.priority !== undefined) base['priority'] = submitted.priority;
  if (submitted.weight !== undefined) base['weight'] = submitted.weight;
  for (const key of ['cost', 'limit'] as const) {
    const value = submitted[key];
    if (value === null) delete base[key];
    else if (value !== undefined) base[key] = value;
  }
  return base;
}
