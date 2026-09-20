import { aiSdkPackagePrimaryProtocol, loadAiSdkProvider, type ProviderFetch, resolveApiKey } from '@aio-proxy/core';
import type { AiSdkProvider, ApiProvider, Provider } from '@aio-proxy/types';
import { apiProviderEndpoints, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { protocolSupportsEvaluation } from '../capability-index';
import { type LazyEvaluationTransport, lazyEvaluationTransport } from '../evaluation-discovery';

/**
 * Which AI SDK package speaks each wire protocol. A mechanical fact, the inverse
 * of `aiSdkPackagePrimaryProtocol` — deliberately NOT a statement about which
 * protocols may serve evaluation.
 *
 * Every classified protocol is listed, including ones whose package has no
 * evaluation resolver, so that `PROTOCOL_CAPABILITIES` stays the only gate. If
 * this map doubled as the policy, adding `evaluation` to the `openai-compatible`
 * row of that table would change nothing and no test would report the drift.
 */
const EVALUATION_BRIDGE_PACKAGES: Readonly<Partial<Record<ProviderProtocol, string>>> = {
  [ProviderProtocol.OpenAIResponse]: '@ai-sdk/openai',
  [ProviderProtocol.OpenAICompatible]: '@ai-sdk/openai-compatible',
  [ProviderProtocol.Anthropic]: '@ai-sdk/anthropic',
  [ProviderProtocol.Gemini]: '@ai-sdk/google',
  [ProviderProtocol.TypeSafeSystemOne]: '@ai-sdk/typesafe-ai',
};

export type EvaluationMaterialization = {
  readonly transport: LazyEvaluationTransport;
  /**
   * Whether the capability index may grant evaluation up front. False leaves the
   * grant to the attempt layer, which awaits discovery — the cold-Gateway case,
   * where no static signal can say whether the package resolves an evaluation
   * model.
   */
  readonly grantsCapability: boolean;
};

type LoadProvider = (packageName: string, options?: Record<string, unknown>) => Promise<unknown>;

/**
 * Builds the evaluation convert transport for a provider, or `undefined` when the
 * provider can never serve it.
 *
 * The transport is attached before the package is loaded and the probe runs on
 * first use. Probing here would import every configured package at startup,
 * turning a slow or missing install into a boot failure instead of a per-attempt
 * candidate failure.
 */
export function evaluationMaterialization(
  config: Provider,
  options: { readonly fetch?: ProviderFetch; readonly loadProvider?: LoadProvider } = {},
): EvaluationMaterialization | undefined {
  if (config.kind === ProviderKind.Api) return apiEvaluation(config, options);
  if (config.kind === ProviderKind.AiSdk) return aiSdkEvaluation(config, options);
  // OAuth providers get no evaluation transport.
  return undefined;
}

/**
 * API convert materializes from the PRIMARY endpoint package only. An extra
 * `openai-response` endpoint on an `openai-compatible` primary grants nothing:
 * the primary package is what a convert attempt would actually call, and inbound
 * System One cannot raw-match a non-System-One endpoint either, so such a
 * candidate could only ever answer 501.
 */
function apiEvaluation(
  config: ApiProvider,
  options: { readonly fetch?: ProviderFetch; readonly loadProvider?: LoadProvider },
): EvaluationMaterialization | undefined {
  // `apiProviderEndpoints` puts the legacy protocol/baseURL pair first, which is
  // the same primary `endpointTransports` exposes.
  const [primary] = apiProviderEndpoints(config);
  if (!protocolSupportsEvaluation(primary.protocol)) return undefined;
  const packageName = EVALUATION_BRIDGE_PACKAGES[primary.protocol];
  if (packageName === undefined) return undefined;
  const apiKey = resolveApiKey(config.apiKey);
  return {
    // A bundled package pinned by protocol: the table already answers whether it
    // resolves evaluation models, so the index need not wait on the probe.
    grantsCapability: true,
    transport: transportFor(config.id, packageName, options, {
      ...(apiKey === undefined ? {} : { apiKey }),
      baseURL: primary.baseURL,
      ...(config.headers === undefined ? {} : { headers: config.headers }),
    }),
  };
}

/**
 * An `ai-sdk` provider names an arbitrary package, so only the probe can say
 * whether it resolves evaluation models. The transport is attached regardless
 * and the capability grant waits, except when the package classifier already
 * pins the package to System One.
 */
function aiSdkEvaluation(
  config: AiSdkProvider,
  options: { readonly fetch?: ProviderFetch; readonly loadProvider?: LoadProvider },
): EvaluationMaterialization {
  return {
    grantsCapability: aiSdkPackagePrimaryProtocol(config.packageName) === ProviderProtocol.TypeSafeSystemOne,
    transport: transportFor(config.id, config.packageName, options, { ...config.options }),
  };
}

function transportFor(
  providerId: string,
  packageName: string,
  options: { readonly fetch?: ProviderFetch; readonly loadProvider?: LoadProvider },
  loadOptions: Record<string, unknown>,
): LazyEvaluationTransport {
  return lazyEvaluationTransport(providerId, () =>
    (options.loadProvider ?? loadAiSdkProvider)(packageName, {
      ...loadOptions,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
  );
}
