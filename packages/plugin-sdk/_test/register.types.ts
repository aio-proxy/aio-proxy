import type { OAuthAdapter, PluginApi } from "../src";

type MyOptions = {
  readonly baseURL: string;
};

type MyCredential = {
  readonly accessToken: string;
};

declare const api: PluginApi;
declare const adapter: OAuthAdapter<MyOptions, MyCredential>;

api.oauth.register(adapter);
