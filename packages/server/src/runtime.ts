import type { AiSdkProviderInstance, ApiProviderInstance, Router } from "@aio-proxy/core";
import type { AliasConfig, ModelId, OAuthVendor, ProviderKind } from "@aio-proxy/types";
import type { UsageRecorder } from "./usage-recorder";

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

export type RuntimeProviderInstance = ApiProviderInstance | AiSdkProviderInstance | OAuthProviderInstance;

export type ProviderRouteSnapshot = {
  readonly providers: readonly RuntimeProviderInstance[];
  readonly router: Router<RuntimeProviderInstance>;
};

export type ProviderRouteSource = {
  readonly currentProviderSnapshot: () => ProviderRouteSnapshot;
  readonly usageRecorder: UsageRecorder;
};
