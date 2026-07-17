import { describe, expect, test } from "bun:test";
import { getGitHubCopilotBaseURL, githubApiBase, normalizeEnterpriseURL } from ".";

describe("GitHub Copilot URLs", () => {
  test("normalizes Enterprise domains to HTTPS origins", () => {
    expect(normalizeEnterpriseURL(" company.ghe.com/path ")).toBe("https://company.ghe.com");
    expect(normalizeEnterpriseURL("https://company.ghe.com/path")).toBe("https://company.ghe.com");
    expect(normalizeEnterpriseURL("not a host name")).toBeUndefined();
  });

  test("builds GitHub API URLs for public and Enterprise deployments", () => {
    expect(githubApiBase(undefined)).toBe("https://api.github.com");
    expect(githubApiBase("https://company.ghe.com")).toBe("https://company.ghe.com/api/v3");
  });

  test("derives the Copilot API endpoint from token metadata", () => {
    expect(getGitHubCopilotBaseURL("tid=x;proxy-ep=proxy.individual.githubcopilot.com;")).toBe(
      "https://api.individual.githubcopilot.com",
    );
    expect(getGitHubCopilotBaseURL(undefined, "https://company.ghe.com")).toBe("https://company.ghe.com");
  });
});
