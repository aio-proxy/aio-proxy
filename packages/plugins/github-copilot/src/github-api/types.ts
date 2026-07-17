import type { LocalizedText } from "@aio-proxy/plugin-sdk";

export type GitHubAccountOptions =
  | { readonly deploymentType: "github.com" }
  | { readonly deploymentType: "enterprise"; readonly enterpriseURL: string };

export type GitHubCopilotCredential = {
  readonly githubToken: string;
  readonly copilotToken: string;
  readonly expiresAt: number;
  readonly baseURL: string;
  readonly enterpriseURL?: string;
};

export type GitHubCopilotLoginPresentationText = {
  readonly deviceInstructions: LocalizedText;
  readonly refreshingToken: LocalizedText;
  readonly waitingForAuthorization: LocalizedText;
};
