import type {
  AiSdkProviderInstance,
  ApiProviderInstance,
  Router,
} from "@aio-proxy/core";
import type { ModelEntry } from "@aio-proxy/types";

export type SubscriptionProviderInstance = {
  readonly id: string;
  readonly kind: "subscription";
  readonly models?: ModelEntry[];
  readonly vendor: "github-copilot";
};

export type RuntimeProviderInstance =
  | ApiProviderInstance
  | AiSdkProviderInstance
  | SubscriptionProviderInstance;

export type ProviderRouteSnapshot = {
  readonly providers: readonly RuntimeProviderInstance[];
  readonly router: Router<RuntimeProviderInstance>;
};

export type ProviderRouteSource = {
  readonly currentProviderSnapshot: () => ProviderRouteSnapshot;
};
