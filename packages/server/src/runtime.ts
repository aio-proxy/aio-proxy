import type { AiSdkProviderInstance, ApiProviderInstance, Router } from "@aio-proxy/core";
import type { ModelEntry, ProviderKind } from "@aio-proxy/types";

export type OAuthProviderInstance = {
  readonly enabled: boolean;
  readonly id: string;
  readonly kind: ProviderKind.OAuth;
  readonly models?: ModelEntry[];
  readonly vendor: "github-copilot";
};

export type RuntimeProviderInstance = ApiProviderInstance | AiSdkProviderInstance | OAuthProviderInstance;

export type ProviderRouteSnapshot = {
  readonly providers: readonly RuntimeProviderInstance[];
  readonly router: Router<RuntimeProviderInstance>;
};

export type ProviderRouteSource = {
  readonly currentProviderSnapshot: () => ProviderRouteSnapshot;
};
