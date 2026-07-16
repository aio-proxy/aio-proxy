import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from "@aio-proxy/plugin-sdk";
import packageJson from "../package.json" with { type: "json" };
import {
  discoverGitHubCopilotModels,
  type GitHubAccountOptions,
  type GitHubCopilotCredential,
  loginToGitHubCopilot,
  normalizeEnterpriseURL,
} from "./github-api";
import { createGitHubCopilotRuntime } from "./runtime";

export type { GitHubAccountOptions, GitHubCopilotCredential } from "./github-api";

export const GITHUB_COPILOT_PLUGIN_VERSION = packageJson.version;
export const COPILOT_CATALOG_TTL_MS = 6 * 60 * 60_000;

export type GitHubCopilotCopy = {
  readonly adapterLabel: LocalizedText;
  readonly deploymentTypeLabel: LocalizedText;
  readonly githubDotComLabel: LocalizedText;
  readonly enterpriseLabel: LocalizedText;
  readonly enterpriseURLLabel: LocalizedText;
  readonly enterpriseURLPlaceholder: LocalizedText;
  readonly deviceInstructions?: LocalizedText;
  readonly refreshingToken?: LocalizedText;
  readonly waitingForAuthorization?: LocalizedText;
};

export const englishCopy: GitHubCopilotCopy = {
  adapterLabel: "Login with GitHub Copilot",
  deploymentTypeLabel: "Select GitHub deployment type",
  githubDotComLabel: "GitHub.com",
  enterpriseLabel: "GitHub Enterprise",
  enterpriseURLLabel: "Enter your GitHub Enterprise URL or domain",
  enterpriseURLPlaceholder: "company.ghe.com or https://company.ghe.com",
  deviceInstructions: "Enter code",
  refreshingToken: "Refreshing GitHub Copilot token",
  waitingForAuthorization: "Waiting for GitHub authorization",
};

export function createGitHubCopilotPlugin(copy: GitHubCopilotCopy): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: zod
      .object({
        deploymentType: zod.enum(["github.com", "enterprise"]).default("github.com"),
        enterpriseURL: zod.string().optional(),
      })
      .superRefine((options, context) => {
        if (options.deploymentType === "enterprise" && normalizeEnterpriseURL(options.enterpriseURL) === undefined) {
          context.addIssue({
            code: "custom",
            message: "GitHub Enterprise URL or domain is required",
            path: ["enterpriseURL"],
          });
        }
      })
      .transform((options): GitHubAccountOptions => {
        if (options.deploymentType === "github.com") return { deploymentType: "github.com" };
        const enterpriseURL = normalizeEnterpriseURL(options.enterpriseURL);
        if (enterpriseURL === undefined) throw new Error("GitHub Enterprise URL or domain is required");
        return { deploymentType: "enterprise", enterpriseURL };
      }),
    form: [
      {
        type: "select",
        key: "deploymentType",
        label: copy.deploymentTypeLabel,
        options: [
          { value: "github.com", label: copy.githubDotComLabel },
          { value: "enterprise", label: copy.enterpriseLabel },
        ],
      },
      {
        type: "text",
        key: "enterpriseURL",
        label: copy.enterpriseURLLabel,
        placeholder: copy.enterpriseURLPlaceholder,
        when: { key: "deploymentType", equals: "enterprise" },
      },
    ],
  } as const satisfies ConfigSpec<GitHubAccountOptions>;

  const adapter: OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential> = {
    id: "default",
    label: copy.adapterLabel,
    account: { options: accountOptions },
    credentials: zod
      .object({
        githubToken: zod.string(),
        copilotToken: zod.string(),
        expiresAt: zod.number(),
        baseURL: zod.url(),
        enterpriseURL: zod.string().optional(),
      })
      .transform(
        ({ enterpriseURL, ...credential }): GitHubCopilotCredential => ({
          ...credential,
          ...(enterpriseURL === undefined ? {} : { enterpriseURL }),
        }),
      ),
    login: async (context, options) => {
      const parsed = await accountOptions.schema.parseAsync(options);
      return await loginToGitHubCopilot(context, parsed, {
        deviceInstructions: copy.deviceInstructions ?? englishCopy.deviceInstructions ?? "Enter code",
        refreshingToken: copy.refreshingToken ?? englishCopy.refreshingToken ?? "Refreshing GitHub Copilot token",
        waitingForAuthorization:
          copy.waitingForAuthorization ?? englishCopy.waitingForAuthorization ?? "Waiting for GitHub authorization",
      });
    },
    catalog: {
      policy: { kind: "ttl", ttlMs: COPILOT_CATALOG_TTL_MS },
      discover: async (context) => ({
        language: await discoverGitHubCopilotModels(context.credentials, context.signal),
        image: [],
        embedding: [],
        speech: [],
        transcription: [],
        reranking: [],
      }),
    },
    createRuntime: createGitHubCopilotRuntime,
  };

  return definePlugin((api) => {
    api.oauth.register(adapter);
  });
}

export default createGitHubCopilotPlugin(englishCopy);
