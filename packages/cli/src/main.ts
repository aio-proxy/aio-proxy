#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "@aio-proxy/core";
import {
  ConfigWriteError,
  formatUserError,
  getLocale,
  m,
  PortOutOfRangeError,
  resolveLocaleFromArgv,
  setLocale,
} from "@aio-proxy/i18n";
import { createServer } from "@aio-proxy/server";
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { type CliDeps, defaultCliDeps } from "./dashboard-assets";
import { ServeListenError } from "./errors";
import { openBrowser } from "./open-browser";
import {
  FormJsonInvalidError,
  FormNumberInvalidError,
  FormSchemaValidationError,
  pluginAdd,
  pluginConfig,
  pluginErrors,
  pluginList,
  pluginPrune,
  pluginRemove,
} from "./plugin-commands";
import { isProviderLoginUserError } from "./plugin-commands/provider-login";
import { providerErrors, providerInstall, providerList, providerLogin, providerTest } from "./provider-commands";

const VERSION = packageJson.version;

const DEFAULT_CONFIG = {
  server: { port: 22_078 },
  providers: {},
} as const;

type ServeOptions = {
  readonly host?: string;
  readonly port?: string;
  readonly open?: boolean;
};

const parsePort = (value: string | undefined, fallback: number) => {
  if (value === undefined) {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new PortOutOfRangeError(value);
  }
  return port;
};

const validatePortArgv = (argv: readonly string[]) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      parsePort(argv[index + 1], DEFAULT_CONFIG.server.port);
      return;
    }
    if (arg?.startsWith("--port=")) {
      parsePort(arg.slice("--port=".length), DEFAULT_CONFIG.server.port);
      return;
    }
  }
};

const readOrBootstrapConfig = async (path: string, dashboardUrl: string) => {
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, undefined, 2)}\n`, {
        mode: 0o600,
      });
    } catch (err) {
      if (err instanceof Error) {
        throw new ConfigWriteError(path);
      }
      throw err;
    }
    if (process.stdin.isTTY !== true) {
      console.log(
        m.cli_bootstrap_empty_config({
          path,
          dashboardUrl,
        }),
      );
    }
  }

  const config: unknown = JSON.parse(await readFile(path, "utf8"));
  return config;
};

const assertPortAvailable = (host: string, port: number) => {
  let probe: { stop(force?: boolean): void } | undefined;
  try {
    probe = Bun.serve({
      hostname: host,
      port,
      fetch: () => new Response(null, { status: 204 }),
    });
  } catch (err) {
    if (err instanceof Error) {
      throw new ServeListenError(host, port, { cause: err });
    }
    throw err;
  } finally {
    probe?.stop(true);
  }
};

const serve = (deps: CliDeps) => async (options: ServeOptions) => {
  const resolvedConfigPath = configPath();
  const host = options.host ?? "127.0.0.1";
  const port = parsePort(options.port, DEFAULT_CONFIG.server.port);
  const apiUrl = `http://${host}:${port}`;
  const dashboardUrl = `${apiUrl}/dashboard`;
  assertPortAvailable(host, port);
  const config = await readOrBootstrapConfig(resolvedConfigPath, dashboardUrl);
  const dashboardAssets = deps.dashboardAssets();
  const app = await createServer({
    config,
    configPath: resolvedConfigPath,
    dashboardAssets,
    host,
    port,
  });
  const server = Bun.serve({ hostname: host, port, fetch: app.fetch });
  console.error(
    m.cli_serve_started({
      apiUrl: `http://${server.hostname}:${server.port}`,
      dashboardUrl: `http://${server.hostname}:${server.port}/dashboard`,
    }),
  );
  if (options.open === true) {
    openBrowser(dashboardUrl);
  }
};

export const buildProgram = (deps: CliDeps = defaultCliDeps) => {
  const program = new Command()
    .name("aio-proxy")
    .description(m.cli_root_description())
    .version(VERSION, "-v, --version", m.cli_version_description())
    .option("--lang <locale>", m.cli_option_lang_description());

  program
    .command("serve")
    .description(m.cli_serve_description())
    .option("--host <host>", m.cli_serve_option_host_description())
    .option("--port <port>", m.cli_serve_option_port_description())
    .option("--open", m.cli_serve_option_open_description())
    .action(serve(deps));

  program
    .command("dashboard")
    .description(m.cli_dashboard_description())
    .action(() => {
      console.error(m.cli_dashboard_not_yet_implemented());
      process.exitCode = 2;
    });
  const provider = program.command("provider").description(m.cli_provider_description());
  provider
    .command("install <package>")
    .description(m.cli_provider_install_description())
    .option("--yes", m.cli_provider_install_option_yes_description())
    .option("--registry <url>", m.cli_provider_install_option_registry_description())
    .action(providerInstall);
  provider
    .command("list")
    .description(m.cli_provider_list_description())
    .option("--url <url>", m.cli_provider_list_option_url_description())
    .option("--filter <provider-id>", m.cli_provider_list_option_filter_description())
    .option("--probe", m.cli_provider_list_option_probe_description())
    .option("--installed", m.cli_provider_list_option_installed_description())
    .action(providerList);
  provider
    .command("login [capability]")
    .description(m.cli_provider_login_description())
    .option("--provider <id>", m.cli_provider_login_option_provider_description())
    .action(providerLogin);
  provider
    .command("test <provider-id>")
    .description(m.cli_provider_test_description())
    .option("--url <url>", m.cli_provider_test_option_url_description())
    .action(providerTest);
  const plugin = program.command("plugin").description(m.cli_plugin_description());
  plugin
    .command("add <package>")
    .description(m.cli_plugin_add_description())
    .option("--yes", m.cli_plugin_add_option_yes_description())
    .option("--registry <url>", m.cli_plugin_add_option_registry_description())
    .action((packageName, options) => pluginAdd(packageName, options));
  plugin
    .command("list")
    .description(m.cli_plugin_list_description())
    .action(() => pluginList({}));
  plugin
    .command("config <package>")
    .description(m.cli_plugin_config_description())
    .option("--clear-secret <key...>", m.cli_plugin_config_option_clear_secret_description())
    .action((packageName, options) => pluginConfig(packageName, options));
  plugin
    .command("remove <package>")
    .description(m.cli_plugin_remove_description())
    .option("--purge-secrets", m.cli_plugin_remove_option_purge_secrets_description())
    .option("--yes", m.cli_plugin_remove_option_yes_description())
    .action((packageName, options) => pluginRemove(packageName, options));
  plugin
    .command("prune")
    .description(m.cli_plugin_prune_description())
    .option("--yes", m.cli_plugin_prune_option_yes_description())
    .action((options) => pluginPrune(options));
  program.command("model").description(m.cli_model_description());
  program.command("trace").description(m.cli_trace_description());

  return program;
};

export const main = async (deps: CliDeps = defaultCliDeps) => {
  try {
    setLocale(resolveLocaleFromArgv(process.argv));
    validatePortArgv(process.argv);
    await buildProgram(deps).parseAsync(process.argv);
  } catch (err) {
    const formatted = formatCliError(err, getLocale());
    console.error(formatted.message);
    process.exitCode = 1;
  }
};

export function formatCliError(err: unknown, locale: Parameters<typeof formatUserError>[1]) {
  if (
    err instanceof ServeListenError ||
    isProviderLoginUserError(err) ||
    (err instanceof Error && providerErrors.some((errorType) => err instanceof errorType)) ||
    err instanceof FormNumberInvalidError ||
    err instanceof FormJsonInvalidError ||
    err instanceof FormSchemaValidationError ||
    (err instanceof Error && pluginErrors.some((errorType) => err instanceof errorType))
  ) {
    return { message: err.message };
  }
  return formatUserError(err, locale);
}

if (import.meta.main) {
  await main();
}
