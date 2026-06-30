#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

setLocale(resolveLocaleFromArgv(process.argv));
const VERSION = packageJson.version;

const DEFAULT_CONFIG = {
  server: { port: 22_078, dashboardPort: 22_079 },
  providers: [],
} as const;

type ServeOptions = {
  readonly host?: string;
  readonly port?: string;
  readonly dashboard?: boolean;
  readonly config?: string;
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

const defaultConfigPath = () => {
  // biome-ignore lint/complexity/useLiteralKeys: process.env is an index signature under noPropertyAccessFromIndexSignature.
  const appData = process.env["APPDATA"];
  if (process.platform === "win32" && appData !== undefined) {
    return join(appData, "aio-proxy", "config.jsonc");
  }
  return join(homedir(), ".config", "aio-proxy", "config.jsonc");
};

const resolveConfigPath = (optionPath: string | undefined) =>
  // biome-ignore lint/complexity/useLiteralKeys: process.env is an index signature under noPropertyAccessFromIndexSignature.
  optionPath ?? process.env["AIO_PROXY_CONFIG"] ?? defaultConfigPath();

const readOrBootstrapConfig = (path: string) => {
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
          dashboardUrl: `http://127.0.0.1:${DEFAULT_CONFIG.server.dashboardPort}`,
        }),
      );
    }
  }

  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  return config;
};

const serve = (options: ServeOptions) => {
  const configPath = resolveConfigPath(options.config);
  const config = readOrBootstrapConfig(configPath);
  const host = options.host ?? "127.0.0.1";
  const port = parsePort(options.port, DEFAULT_CONFIG.server.port);
  const app = createServer({ config, host, port });
  Bun.serve({ hostname: host, port, fetch: app.fetch });
};

const runStub = () => {};

export const buildProgram = () => {
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
    .option("--dashboard", m.cli_serve_option_dashboard_description())
    .option("--config <path>", m.cli_serve_option_config_description())
    .action(serve);

  program
    .command("dashboard")
    .description(m.cli_dashboard_description())
    .action(runStub);
  program
    .command("provider")
    .description(m.cli_provider_description())
    .action(runStub);
  program
    .command("model")
    .description(m.cli_model_description())
    .action(runStub);
  program
    .command("trace")
    .description(m.cli_trace_description())
    .action(runStub);

  return program;
};

export const main = async () => {
  try {
    validatePortArgv(process.argv);
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    const formatted = formatUserError(err, getLocale());
    console.error(formatted.message);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
