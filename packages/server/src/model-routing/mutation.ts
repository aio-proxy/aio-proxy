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
  const submitted = Object.fromEntries(Object.entries(input.providers).filter(([, value]) => !isEmptyOverride(value)));
  return writeRawModelPolicy(current, input.modelId, { ...preserved, ...submitted });
}

export function readRawModelPolicy(current: Record<string, unknown>, modelId: string): unknown {
  const router = current['router'];
  if (!isPlainObject(router)) return undefined;
  const models = router['models'];
  if (!isPlainObject(models)) return undefined;
  return Object.hasOwn(models, modelId) ? models[modelId] : undefined;
}

export function writeRawModelPolicy(
  current: Record<string, unknown>,
  modelId: string,
  providers: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const currentRouter = isPlainObject(current['router']) ? current['router'] : {};
  const currentModels = isPlainObject(currentRouter['models']) ? { ...currentRouter['models'] } : {};
  const currentPolicy = isPlainObject(currentModels[modelId]) ? currentModels[modelId] : {};
  const { providers: _ignored, ...futurePolicyFields } = currentPolicy;
  const hasProviders = Object.keys(providers).length > 0;
  const hasFuturePolicy = Object.keys(futurePolicyFields).length > 0;

  if (!hasProviders && !hasFuturePolicy) delete currentModels[modelId];
  else {
    currentModels[modelId] = {
      ...futurePolicyFields,
      ...(hasProviders ? { providers } : {}),
    };
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

function isEmptyOverride(value: unknown): boolean {
  return isPlainObject(value) && value['priority'] === undefined && value['weight'] === undefined;
}
