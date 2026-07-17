export function normalizeEnterpriseURL(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.hostname === "" || url.hostname.includes(" ")) return undefined;
    return `https://${url.hostname}`;
  } catch {
    return undefined;
  }
}

export function getGitHubCopilotBaseURL(token?: string, enterpriseURL?: string): string {
  const proxyEndpoint = token?.match(/(?:^|;)proxy-ep=([^;]+)/)?.[1];
  if (proxyEndpoint !== undefined) {
    const apiEndpoint = proxyEndpoint.startsWith("proxy.")
      ? `api.${proxyEndpoint.slice("proxy.".length)}`
      : proxyEndpoint;
    return `https://${apiEndpoint}`;
  }
  return enterpriseURL ?? "https://api.githubcopilot.com";
}

export function githubApiBase(enterpriseURL: string | undefined): string {
  return enterpriseURL === undefined ? "https://api.github.com" : `${enterpriseURL}/api/v3`;
}
