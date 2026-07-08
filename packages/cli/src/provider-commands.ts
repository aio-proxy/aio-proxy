import { spawn, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import {
  configPath,
  listInstalledNpmPackages,
  NpmInstallError,
  NpmPackageEntrypointError,
  NpmPackageJsonError,
  NpmPackageNameError,
  npmAdd,
} from "@aio-proxy/core";
import {
  Auth,
  githubCopilotOAuthProvider,
  normalizeDomain,
  type OAuthLoginForm,
  type OAuthLoginInput,
  type OAuthPrompt,
} from "@aio-proxy/oauth";
import { type DashboardProviderSummary, DashboardProvidersResponseSchema } from "@aio-proxy/types";
import { confirm, input, select } from "@inquirer/prompts";
import { openAIChatGPTOAuthProvider } from "../../oauth/src/openai-chatgpt";
import { ProviderDashboardError } from "./errors";

export type ProviderInstallOptions = {
  readonly yes?: boolean;
  readonly registry?: string;
};

export type ProviderListOptions = {
  readonly filter?: string;
  readonly installed?: boolean;
  readonly probe?: boolean;
  readonly url?: string;
};

export type ProviderLoginOptions = Record<string, never>;

type LoginForCliResult = {
  readonly payload: Record<string, unknown>;
  readonly providerId: string;
};

const defaultDashboardUrl = "http://127.0.0.1:22078";

export const providerErrors = [
  NpmInstallError,
  NpmPackageNameError,
  NpmPackageJsonError,
  NpmPackageEntrypointError,
] as const;

export async function providerInstall(pkg: string, options: ProviderInstallOptions): Promise<void> {
  if (options.yes !== true && !(await confirmInstall(pkg))) {
    console.error(`provider install ${pkg} requires --yes`);
    process.exitCode = 1;
    return;
  }
  const installed = await npmAdd(pkg, options.registry);
  console.log(`${pkg} ${installed.version} ${installed.entrypoint}`);
}

export async function providerLogin(family: string, _options: ProviderLoginOptions): Promise<void> {
  const result =
    family === "copilot"
      ? await runCopilotLoginForCli()
      : family === "chatgpt"
        ? await runChatGPTLoginForCli()
        : undefined;
  if (result === undefined) {
    console.error(`unknown oauth provider family: ${family}`);
    process.exitCode = 1;
    return;
  }

  const resolvedConfigPath = configPath();
  const config = JSON.parse(await Bun.file(resolvedConfigPath).text()) as { providers?: Record<string, unknown> };
  const providers = config.providers ?? {};
  providers[result.providerId] = {
    kind: "oauth",
    vendor: family === "chatgpt" ? "openai-chatgpt" : "github-copilot",
  };
  await Bun.write(resolvedConfigPath, `${JSON.stringify({ ...config, providers }, null, 2)}\n`);
  console.log(result.providerId);
}

async function runCopilotLoginForCli(): Promise<LoginForCliResult> {
  const fake = (process.env as { readonly AIO_PROXY_TEST_COPILOT_LOGIN?: string }).AIO_PROXY_TEST_COPILOT_LOGIN;
  if (fake !== undefined) {
    const result = JSON.parse(fake) as LoginForCliResult;
    Auth.set("github-copilot", result.providerId, result.payload, result.providerId);
    return result;
  }

  const result = await githubCopilotOAuthProvider.login(
    await collectOAuthLoginInput(githubCopilotOAuthProvider.loginForm),
    {
      onAuth: ({ url, instructions, userCode }) => {
        clearProgressLine();
        if (userCode !== undefined && copyToClipboard(userCode)) {
          console.log("Copied GitHub device code to clipboard.");
        }
        if (openBrowser(url)) {
          console.log("Opened GitHub login in your default browser.");
        }
        console.log(url);
        if (instructions !== undefined) {
          console.log(instructions);
        }
      },
      onProgress: (message) => writeProgressLine(message),
    },
  );
  clearProgressLine();
  return { payload: result.payload, providerId: result.providerId };
}

async function runChatGPTLoginForCli(): Promise<LoginForCliResult> {
  const fake = (process.env as { readonly AIO_PROXY_TEST_CHATGPT_LOGIN?: string }).AIO_PROXY_TEST_CHATGPT_LOGIN;
  if (fake !== undefined) {
    const result = JSON.parse(fake) as LoginForCliResult;
    Auth.set("openai-chatgpt", result.providerId, result.payload, result.providerId);
    return result;
  }

  const result = await openAIChatGPTOAuthProvider.login(
    await collectOAuthLoginInput(openAIChatGPTOAuthProvider.loginForm),
    {
      onAuth: ({ url }) => {
        clearProgressLine();
        if (openBrowser(url)) {
          console.log("Opened ChatGPT login in your default browser.");
        }
        console.log(url);
      },
      onProgress: (message) => writeProgressLine(message),
    },
  );
  clearProgressLine();
  return { payload: result.payload, providerId: result.providerId };
}

async function collectOAuthLoginInput(form: OAuthLoginForm): Promise<OAuthLoginInput> {
  if (process.stdin.isTTY !== true) {
    return {};
  }

  const values: Record<string, string | undefined> = {};
  for (const prompt of form.prompts) {
    if (!shouldShowPrompt(prompt, values)) {
      continue;
    }
    if (prompt.type === "select") {
      values[prompt.key] = await select({
        message: prompt.message,
        choices: prompt.options.map((option) => ({
          name: option.label,
          value: option.value,
          ...(option.hint === undefined ? {} : { description: option.hint }),
        })),
      });
      continue;
    }
    values[prompt.key] = await input({
      message: prompt.placeholder === undefined ? prompt.message : `${prompt.message} (${prompt.placeholder})`,
      validate: (value) => validateTextPrompt(prompt, value),
    });
  }

  return values;
}

function shouldShowPrompt(prompt: OAuthPrompt, values: Record<string, string | undefined>): boolean {
  if (prompt.when === undefined) {
    return true;
  }
  return prompt.when.op === "eq" && values[prompt.when.key] === prompt.when.value;
}

function validateTextPrompt(prompt: Extract<OAuthPrompt, { type: "text" }>, value: string): true | string {
  if (prompt.validate?.required === true && value.trim() === "") {
    return "URL or domain is required";
  }
  if (prompt.validate?.format === "domain-or-url" && normalizeDomain(value) === null) {
    return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)";
  }
  return true;
}

function writeProgressLine(message: string): void {
  if (process.stderr.isTTY !== true) {
    return;
  }
  process.stderr.write(`\r${message}...`);
}

function clearProgressLine(): void {
  if (process.stderr.isTTY !== true) {
    return;
  }
  process.stderr.write("\r\x1b[2K");
}

function openBrowser(url: string): boolean {
  const command =
    process.platform === "darwin"
      ? { bin: "open", args: [url] }
      : process.platform === "win32"
        ? { bin: "cmd", args: ["/c", "start", "", url] }
        : { bin: "xdg-open", args: [url] };
  try {
    const child = spawn(command.bin, command.args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function copyToClipboard(value: string): boolean {
  const commands =
    process.platform === "darwin"
      ? [{ bin: "pbcopy", args: [] as string[] }]
      : process.platform === "win32"
        ? [{ bin: "clip", args: [] as string[] }]
        : [
            { bin: "wl-copy", args: [] as string[] },
            { bin: "xclip", args: ["-selection", "clipboard"] },
            { bin: "xsel", args: ["--clipboard", "--input"] },
          ];

  return commands.some((command) => {
    try {
      return spawnSync(command.bin, command.args, { input: value, stdio: ["pipe", "ignore", "ignore"] }).status === 0;
    } catch {
      return false;
    }
  });
}

async function confirmInstall(pkg: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  return confirm({
    default: false,
    message: `Install and dynamically load ${pkg}? Only continue if you trust this package.`,
  });
}

export async function providerList(options: ProviderListOptions): Promise<void> {
  if (options.installed === true) {
    await providerInstalledList();
    return;
  }

  const url = new URL("/dashboard/api/providers", options.url ?? defaultDashboardUrl);
  if (options.probe === true) {
    url.searchParams.set("probe", "true");
  }
  if (options.filter !== undefined) {
    url.searchParams.set("filter", options.filter);
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new ProviderDashboardError(response.status, url.toString());
  }
  const parsed = DashboardProvidersResponseSchema.parse(await response.json());
  printProviderTable(parsed.providers, options.probe === true);
}

export async function providerTest(id: string, options: Omit<ProviderListOptions, "filter" | "probe">): Promise<void> {
  await providerList({ ...options, filter: id, probe: true });
}

async function providerInstalledList(): Promise<void> {
  const installed = await listInstalledNpmPackages();
  for (const item of installed) {
    console.log(`${item.packageName} ${item.version} ${dirname(item.entrypoint)}`);
  }
}

function printProviderTable(providers: readonly DashboardProviderSummary[], probe: boolean): void {
  const headers = ["id", "kind", "enabled", "passthrough", "last_status", "last_latency", ...(probe ? ["probe"] : [])];
  console.log(headers.join(" | "));
  for (const provider of providers) {
    console.log(
      [
        provider.id,
        provider.kind,
        String(provider.enabled),
        String(provider.passthrough),
        provider.last_status,
        provider.last_latency === null ? "-" : String(provider.last_latency),
        ...(probe ? [provider.probe ?? "FAIL"] : []),
      ].join(" | "),
    );
  }
}
