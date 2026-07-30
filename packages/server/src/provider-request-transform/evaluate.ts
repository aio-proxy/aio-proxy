import { updateOne } from 'mingo';

import type { CompiledProviderRequestTransforms } from './compile';
import { MINGO_OPTIONS } from './compile';
import { ProviderRequestTransformError, type ProviderRequestTransformLocation } from './error';

export type ProviderRequestTransformJson =
  | null
  | boolean
  | number
  | string
  | ProviderRequestTransformJson[]
  | { [key: string]: ProviderRequestTransformJson };

export type ProviderRequestTransformProvider = {
  readonly id: string;
  readonly kind: string;
  readonly protocol?: string;
};

export type ProviderRequestTransformRequest = {
  readonly model: string;
  readonly requestedModel: string;
  readonly sourceProtocol: string;
  readonly targetProtocol?: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: ProviderRequestTransformJson;
};

export type ProviderRequestTransformInput = {
  readonly provider: ProviderRequestTransformProvider;
  readonly request: ProviderRequestTransformRequest;
};

export type ProviderRequestTransformResult = {
  readonly request: ProviderRequestTransformRequest;
  readonly bodyLoaded: boolean;
  readonly bodyModified: boolean;
  readonly lastAppliedLocation: ProviderRequestTransformLocation | undefined;
  readonly headerWriteLocations: ReadonlyMap<string, ProviderRequestTransformLocation>;
};

export async function evaluateProviderRequestTransforms(
  compiled: CompiledProviderRequestTransforms,
  input: ProviderRequestTransformInput,
  loadBody: (location: ProviderRequestTransformLocation) => Promise<ProviderRequestTransformJson>,
): Promise<ProviderRequestTransformResult> {
  const provider = input.provider;
  let original = input.request;
  let current = input.request;
  let bodyLoaded: boolean = false;
  let bodyModified = false;
  let lastAppliedLocation: ProviderRequestTransformLocation | undefined;
  const headerWriteLocations = new Map<string, ProviderRequestTransformLocation>();

  const ensureBody = async (location: ProviderRequestTransformLocation): Promise<boolean> => {
    if (bodyLoaded) return true;
    const body = await loadBody(location);
    original = { ...original, body: structuredClone(body) };
    current = { ...current, body: structuredClone(body) };
    return true;
  };

  for (const rule of compiled.rules) {
    const ruleLocation = {
      ruleIndex: rule.ruleIndex,
      ...(rule.name === undefined ? {} : { ruleName: rule.name }),
    };
    if (rule.whenReadsBody) bodyLoaded = await ensureBody(ruleLocation);
    const conditionDocument = evaluationDocument(provider, original, current);
    let matched: boolean;
    try {
      matched = rule.query.test(conditionDocument);
    } catch {
      throw new ProviderRequestTransformError({
        code: 'REQUEST_TRANSFORM_EVALUATION_FAILED',
        ...ruleLocation,
      });
    }
    if (!matched) continue;

    for (const stage of rule.stages) {
      const location = { ...ruleLocation, stageIndex: stage.stageIndex };
      if (stage.readsBody || stage.writesBody) bodyLoaded = await ensureBody(location);
      const stageDocument = evaluationDocument(provider, original, current);
      try {
        updateOne([stageDocument], {}, [stage.document] as Parameters<typeof updateOne>[2], undefined, MINGO_OPTIONS);
        current = structuredClone(stageDocument.request);
        bodyModified ||= stage.writesBody;
        lastAppliedLocation = location;
        if (stage.headerTarget !== undefined) headerWriteLocations.set(stage.headerTarget, location);
      } catch {
        throw new ProviderRequestTransformError({
          code: 'REQUEST_TRANSFORM_EVALUATION_FAILED',
          ...location,
        });
      }
    }
  }

  return { request: current, bodyLoaded, bodyModified, lastAppliedLocation, headerWriteLocations };
}

function evaluationDocument(
  provider: ProviderRequestTransformProvider,
  original: ProviderRequestTransformRequest,
  current: ProviderRequestTransformRequest,
): Record<string, unknown> & { request: ProviderRequestTransformRequest } {
  return {
    provider,
    original: structuredClone(original),
    request: structuredClone(current),
  };
}
