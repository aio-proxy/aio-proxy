import type { AiSdkProviderInstance, ApiProviderInstance, Router } from "@aio-proxy/core";
import type { AliasConfig, ModelId, OAuthVendor, ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import type { RequestRecorder } from "./request-recorder";
import type { UsageCapture } from "./usage-capture";

export type OAuthProviderInstance = {
  readonly enabled: boolean;
  readonly ensureAvailable?: () => Promise<void>;
  readonly id: string;
  readonly invoke: AiSdkProviderInstance["invoke"];
  readonly kind: ProviderKind.OAuth;
  readonly models?: ModelId[];
  readonly alias?: Readonly<Record<string, AliasConfig>>;
  readonly vendor: OAuthVendor.GitHubCopilot | OAuthVendor.OpenAIChatGPT;
};

export type RawTransport = {
  readonly protocol: ProviderProtocol;
  readonly invoke: ApiProviderInstance["passthrough"];
};

export type ModelTransport = {
  readonly ensureAvailable?: () => Promise<void>;
  readonly invoke: AiSdkProviderInstance["invoke"];
};

export type RuntimeCapabilities =
  | { readonly raw: RawTransport; readonly model?: ModelTransport }
  | { readonly raw?: RawTransport; readonly model: ModelTransport };

export type LegacyRuntimeProviderInstance = ApiProviderInstance | AiSdkProviderInstance | OAuthProviderInstance;
export type RuntimeProviderInstance = LegacyRuntimeProviderInstance & RuntimeCapabilities;
export type RuntimeProviderInput = LegacyRuntimeProviderInstance | RuntimeProviderInstance;

export type ProviderRouteSnapshot = {
  readonly providers: readonly RuntimeProviderInstance[];
  readonly router: Router<RuntimeProviderInstance>;
};

export type ProviderRouteSource = {
  readonly currentProviderSnapshot: () => ProviderRouteSnapshot;
  readonly requestRecorder: RequestRecorder;
  readonly usageCapture: UsageCapture;
};
