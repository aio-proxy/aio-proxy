import type { AiSdkProviderInstance, ApiProviderInstance, Router } from "@aio-proxy/core";
import type { ModelEntry, OAuthVendor, ProviderKind } from "@aio-proxy/types";

export type OAuthProviderInstance = {
  readonly enabled: boolean;
  readonly ensureAvailable?: () => Promise<void>;
  readonly id: string;
  readonly invoke: AiSdkProviderInstance["invoke"];
  readonly kind: ProviderKind.OAuth;
  readonly models?: ModelEntry[];
  readonly vendor: OAuthVendor.GitHubCopilot;
};

export type RuntimeProviderInstance = ApiProviderInstance | AiSdkProviderInstance | OAuthProviderInstance;

export type ProviderRouteSnapshot = {
  readonly providers: readonly RuntimeProviderInstance[];
  readonly router: Router<RuntimeProviderInstance>;
};

export type ProviderRouteSource = {
  readonly currentProviderSnapshot: () => ProviderRouteSnapshot;
};
