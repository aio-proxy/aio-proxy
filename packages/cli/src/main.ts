#!/usr/bin/env bun
import { homedir } from 'node:os';
import { basename } from 'node:path';

import { formatUserError, getLocale, m, resolveLocaleFromArgv, setLocale } from '@aio-proxy/i18n';
import { Command, CommanderError } from 'commander';

import packageJson from '../package.json' with { type: 'json' };
import { agentConfigure, agentList, agentRemove, agentRevoke, createAgentCommandDeps } from './agent';
import { runCodexAuthCommand } from './agent/codex';
import { loadGrokPolicy } from './agent/grok';
import { grokAuth, GrokAuthError, createGrokTransport } from './agent/grok-auth';
import { resolveGrokRoot } from './agent/hosts';
import { registerAgentCommands } from './agent/output';
import { completionCommand } from './completion';
import { configEdit, configPathCommand, configShow, configValidate } from './config-cmd';
import { dashboardCommand } from './dashboard';
import { type CliDeps, defaultCliDeps } from './dashboard-assets';
import { doctorCommand } from './doctor';
import { isKnownCliUserError, toExitCode } from './exit';
import { pluginAdd, pluginConfig, pluginList, pluginPrune, pluginRemove } from './plugin-commands';
import { providerImport, providerList, providerLogin, providerTest } from './provider-commands';
import { reloadCommand } from './reload';
import { run, validatePortArgv } from './run';
import { serviceInstall, serviceRestart, serviceStart, serviceStatus, serviceStop, serviceUninstall } from './service';
import { statusCommand } from './status';
import { printUpdateBanner, shouldPrintUpdateBanner } from './update-notify';
import { runUpgradeCommand } from './upgrade/upgrade';

export { readOrBootstrapConfig } from './run';

const VERSION = packageJson.version;

const codexAuthInvocation = (argv: readonly string[]): string | undefined => {
  if (argv[0] !== 'agent' || argv[1] !== 'auth' || argv[2] !== 'codex') return undefined;
  if (argv.length !== 5 || argv[3] !== '--installation-id') throw new Error('Codex auth requires --installation-id');
  return argv[4];
};

export function writeStdoutLine(
  line: string,
  write: (chunk: string, callback: (error?: Error | null) => void) => void = (chunk, callback) => {
    process.stdout.write(chunk, callback);
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    write(line, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const commandChain = (command: Command): string[] => {
  const names: string[] = [];
  for (let current: Command | null | undefined = command; current; current = current.parent) {
    names.push(current.name());
  }
  return names;
};

const registerServiceCommands = (program: Command): void => {
  const service = program.command('service').description(m['cli.service.description']());
  service
    .command('install')
    .description(m['cli.service.install_description']())
    .option('--user', m['cli.service.install_option_user_description']())
    .option('--system', m['cli.service.install_option_system_description']())
    .action((options) => serviceInstall(options));
  service
    .command('uninstall')
    .description(m['cli.service.uninstall_description']())
    .action(() => serviceUninstall());
  service
    .command('start')
    .description(m['cli.service.start_description']())
    .action(() => serviceStart());
  service
    .command('stop')
    .description(m['cli.service.stop_description']())
    .action(() => serviceStop());
  service
    .command('restart')
    .description(m['cli.service.restart_description']())
    .action(() => serviceRestart());
  service
    .command('status')
    .description(m['cli.service.status_description']())
    .action(() => serviceStatus());
};

export const invokedProgramName = (
  argv0: string | undefined = process.argv0,
  execPath: string | undefined = process.execPath,
): string => {
  for (const value of [argv0, execPath]) {
    if (basename(value ?? '').replace(/\.(js|ts)$/, '') === 'aiop') return 'aiop';
  }
  return 'aio-proxy';
};

const bindAgentCommands = (program: Command, deps: CliDeps): void => {
  const commandDeps = createAgentCommandDeps(deps);
  registerAgentCommands(program, {
    actions: {
      list: (options) => agentList(options, commandDeps),
      configure: (target, options) => agentConfigure(target, options, commandDeps),
      remove: (target) => agentRemove(target, commandDeps),
      revoke: (installationId) => agentRevoke(installationId, commandDeps),
      authCodex: (installationId) => runCodexAuthCommand(installationId),
      auth: async (target, options) => {
        if (target === 'codex') {
          await runCodexAuthCommand(options.installationId);
          return;
        }
        if (target !== 'grok') throw new Error('Unsupported auth command target');
        await grokAuth(
          {
            root: resolveGrokRoot(process.env, homedir()),
            installationId: options.installationId,
            adapterVersion: commandDeps.adapterVersion,
            expired: process.env.GROK_AUTH_EXPIRED === '1',
          },
          {
            now: Date.now,
            policy: loadGrokPolicy,
            transport: (marker, budget) => createGrokTransport(marker, budget),
            stdout: writeStdoutLine,
            stderr: (line) => {
              process.stderr.write(line);
            },
          },
        );
      },
    },
    print: console.log,
  });
};

const registerHiddenPostUpgrade = (program: Command, deps: CliDeps): void => {
  program.command('__agent-post-upgrade', { hidden: true }).action(async () => {
    const [{ createAgentCommandDeps }, { readAgentPostUpgradePayload, runAgentPostUpgrade }] = await Promise.all([
      import('./agent'),
      import('./upgrade/post-upgrade-agents'),
    ]);
    const payload = await readAgentPostUpgradePayload();
    const agent = createAgentCommandDeps(deps);
    const results = await runAgentPostUpgrade(payload, {
      resolveLocation: agent.resolveLocation,
      inspect: agent.inspect,
      install: agent.install,
      readAssets: agent.readAssets,
      adapterVersion: VERSION,
      now: agent.now,
    });
    console.log(JSON.stringify(results));
  });
};

export const buildProgram = (deps: CliDeps = defaultCliDeps, programName = invokedProgramName()) => {
  const program = new Command()
    .name(programName)
    .description(m['cli.root.description']())
    .version(VERSION, '-v, --version', m['cli.version.description']())
    .option('--lang <locale>', m['cli.option.lang_description']());

  program.configureOutput({
    writeOut: (chunk) => process.stdout.write(chunk),
    writeErr: (chunk) => process.stderr.write(chunk),
  });

  program.hook('preAction', (_thisCommand, actionCommand) => {
    if (!shouldPrintUpdateBanner(commandChain(actionCommand), process.argv)) return;
    printUpdateBanner(VERSION);
  });

  program
    .command('run')
    .description(m['cli.run.description']())
    .option('--host <host>', m['cli.run.option_host_description']())
    .option('--port <port>', m['cli.run.option_port_description']())
    .option('--open', m['cli.run.option_open_description']())
    .action(run(deps));

  program
    .command('reload')
    .description(m['cli.reload.description']())
    .option('--host <host>', m['cli.run.option_host_description']())
    .option('--port <port>', m['cli.run.option_port_description']())
    .action(reloadCommand);

  program
    .command('status')
    .description(m['cli.status.description']())
    .option('--host <host>', m['cli.run.option_host_description']())
    .option('--port <port>', m['cli.run.option_port_description']())
    .option('--deep', m['cli.status.option_deep_description']())
    .option('--json')
    .action((options) => statusCommand(options));

  const config = program.command('config').description(m['cli.config.description']());
  config
    .command('show')
    .description(m['cli.config.show_description']())
    .option('--json')
    .action((options) => configShow(options));
  config
    .command('edit')
    .description(m['cli.config.edit_description']())
    .action(async () => await configEdit());
  config
    .command('validate [path]')
    .description(m['cli.config.validate_description']())
    .action((path) => configValidate(path));
  config
    .command('path')
    .description(m['cli.config.path_description']())
    .action(() => configPathCommand());

  program
    .command('dashboard')
    .description(m['cli.dashboard.description']())
    .option('--host <host>', m['cli.run.option_host_description']())
    .option('--port <port>', m['cli.run.option_port_description']())
    .action((options) => dashboardCommand(options));
  const provider = program.command('provider').description(m['cli.provider.description']());
  provider
    .command('list')
    .description(m['cli.provider.list.description']())
    .option('--url <url>', m['cli.provider.list.option_url_description']())
    .option('--filter <provider-id>', m['cli.provider.list.option_filter_description']())
    .option('--probe', m['cli.provider.list.option_probe_description']())
    .option('--installed', m['cli.provider.list.option_installed_description']())
    .action(providerList);
  provider
    .command('login [capability]')
    .description(m['cli.provider.login.description']())
    .option('--provider <id>', m['cli.provider.login.option_provider_description']())
    .action(providerLogin);
  provider
    .command('import [path]')
    .description(m['cli.provider.import.description']())
    .action((path) => providerImport(path));
  provider
    .command('test <provider-id>')
    .description(m['cli.provider.test.description']())
    .option('--url <url>', m['cli.provider.test.option_url_description']())
    .action(providerTest);
  const plugin = program.command('plugin').description(m['cli.plugin.description']());
  plugin
    .command('add <package>')
    .description(m['cli.plugin.add_description']())
    .option('--yes', m['cli.plugin.add_option_yes_description']())
    .option('--registry <url>', m['cli.plugin.add_option_registry_description']())
    .action((packageName, options) => pluginAdd(packageName, options));
  plugin
    .command('list')
    .description(m['cli.plugin.list_description']())
    .action(() => pluginList({}));
  plugin
    .command('config <package>')
    .description(m['cli.plugin.config_description']())
    .option('--clear-secret <key...>', m['cli.plugin.config_option_clear_secret_description']())
    .action((packageName, options) => pluginConfig(packageName, options));
  plugin
    .command('remove <package>')
    .description(m['cli.plugin.remove_description']())
    .option('--purge-secrets', m['cli.plugin.remove_option_purge_secrets_description']())
    .option('--yes', m['cli.plugin.remove_option_yes_description']())
    .action((packageName, options) => pluginRemove(packageName, options));
  plugin
    .command('prune')
    .description(m['cli.plugin.prune_description']())
    .option('--yes', m['cli.plugin.prune_option_yes_description']())
    .action((options) => pluginPrune(options));
  registerServiceCommands(program);

  program
    .command('doctor')
    .description(m['cli.doctor.description']())
    .option('--host <host>', m['cli.run.option_host_description']())
    .option('--port <port>', m['cli.run.option_port_description']())
    .action((options) => doctorCommand(options));

  program
    .command('completion <shell>')
    .description(m['cli.completion.description']())
    .action((shell) => completionCommand(shell));

  program
    .command('upgrade')
    .alias('update')
    .description(m['cli.upgrade.description']())
    .option('--check', m['cli.upgrade.option_check_description']())
    .option('--force', m['cli.upgrade.option_force_description']())
    .option('--registry <url>', m['cli.upgrade.option_registry_description']())
    .action(async (options) => {
      await runUpgradeCommand(options);
    });

  bindAgentCommands(program, deps);
  registerHiddenPostUpgrade(program, deps);

  return program;
};

export const main = async (deps: CliDeps = defaultCliDeps) => {
  try {
    const installationId = codexAuthInvocation(process.argv.slice(2));
    if (installationId !== undefined) {
      await runCodexAuthCommand(installationId);
      return;
    }
    await setLocale(resolveLocaleFromArgv(process.argv));
    validatePortArgv(process.argv);
    await buildProgram(deps).parseAsync(process.argv);
  } catch (err) {
    const formatted = formatCliError(err, getLocale());
    // A signal-only error (e.g. `status` on a down daemon) already printed its result
    // and carries an empty message; only its exit code matters, so skip the blank line.
    if (formatted.message !== '') console.error(formatted.message);
    process.exitCode = toExitCode(err);
  }
};

export function formatCliError(err: unknown, locale: Parameters<typeof formatUserError>[1]) {
  if (err instanceof GrokAuthError && err.code === 'login_required') {
    return { message: m['cli.agent.grok_login_required']() };
  }
  if (err instanceof Error) {
    const conflict = /^Grok routing conflict: (.+)$/u.exec(err.message);
    if (conflict?.[1] !== undefined) return { message: m['cli.agent.grok_policy_conflict']({ fields: conflict[1] }) };
  }
  if (err instanceof CommanderError || isKnownCliUserError(err)) {
    return { message: err.message };
  }
  return formatUserError(err, locale);
}

if (import.meta.main) {
  await main();
}
