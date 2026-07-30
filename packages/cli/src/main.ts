#!/usr/bin/env bun
import { formatUserError, getLocale, m, resolveLocaleFromArgv, setLocale } from '@aio-proxy/i18n';
import { Command } from 'commander';

import packageJson from '../package.json' with { type: 'json' };
import { completionCommand } from './completion';
import { configEdit, configPathCommand, configShow, configValidate } from './config-cmd';
import { type CliDeps, defaultCliDeps } from './dashboard-assets';
import { doctorCommand } from './doctor';
import { CliExit, isKnownCliUserError, toExitCode } from './exit';
import { pluginAdd, pluginConfig, pluginList, pluginPrune, pluginRemove } from './plugin-commands';
import { providerList, providerLogin, providerTest } from './provider-commands';
import { reloadCommand } from './reload';
import { run, validatePortArgv } from './run';
import { serviceInstall, serviceRestart, serviceStart, serviceStatus, serviceStop, serviceUninstall } from './service';
import { statusCommand } from './status';

export { readOrBootstrapConfig } from './run';

const VERSION = packageJson.version;

const registerServiceCommands = (program: Command): void => {
  const service = program.command('service').description(m.cli_service_description());
  service
    .command('install')
    .description(m.cli_service_install_description())
    .option('--user', m.cli_service_install_option_user_description())
    .option('--system', m.cli_service_install_option_system_description())
    .action((options) => serviceInstall(options));
  service
    .command('uninstall')
    .description(m.cli_service_uninstall_description())
    .action(() => serviceUninstall());
  service
    .command('start')
    .description(m.cli_service_start_description())
    .action(() => serviceStart());
  service
    .command('stop')
    .description(m.cli_service_stop_description())
    .action(() => serviceStop());
  service
    .command('restart')
    .description(m.cli_service_restart_description())
    .action(() => serviceRestart());
  service
    .command('status')
    .description(m.cli_service_status_description())
    .action(() => serviceStatus());
};

export const buildProgram = (deps: CliDeps = defaultCliDeps) => {
  const program = new Command()
    .name('aio-proxy')
    .description(m.cli_root_description())
    .version(VERSION, '-v, --version', m.cli_version_description())
    .option('--lang <locale>', m.cli_option_lang_description());

  program
    .command('run')
    .description(m.cli_run_description())
    .option('--host <host>', m.cli_run_option_host_description())
    .option('--port <port>', m.cli_run_option_port_description())
    .option('--open', m.cli_run_option_open_description())
    .action(run(deps));

  program
    .command('reload')
    .description(m.cli_reload_description())
    .option('--host <host>', m.cli_run_option_host_description())
    .option('--port <port>', m.cli_run_option_port_description())
    .action(reloadCommand);

  program
    .command('status')
    .description(m.cli_status_description())
    .option('--host <host>', m.cli_run_option_host_description())
    .option('--port <port>', m.cli_run_option_port_description())
    .option('--deep', m.cli_status_option_deep_description())
    .option('--json')
    .action((options) => statusCommand(options));

  const config = program.command('config').description(m.cli_config_description());
  config
    .command('show')
    .description(m.cli_config_show_description())
    .option('--json')
    .action((options) => configShow(options));
  config
    .command('edit')
    .description(m.cli_config_edit_description())
    .action(async () => await configEdit());
  config
    .command('validate [path]')
    .description(m.cli_config_validate_description())
    .action((path) => configValidate(path));
  config
    .command('path')
    .description(m.cli_config_path_description())
    .action(() => configPathCommand());

  program
    .command('dashboard')
    .description(m.cli_dashboard_description())
    .action(() => {
      throw new CliExit(1, m.cli_dashboard_not_yet_implemented());
    });
  const provider = program.command('provider').description(m.cli_provider_description());
  provider
    .command('list')
    .description(m.cli_provider_list_description())
    .option('--url <url>', m.cli_provider_list_option_url_description())
    .option('--filter <provider-id>', m.cli_provider_list_option_filter_description())
    .option('--probe', m.cli_provider_list_option_probe_description())
    .option('--installed', m.cli_provider_list_option_installed_description())
    .action(providerList);
  provider
    .command('login [capability]')
    .description(m.cli_provider_login_description())
    .option('--provider <id>', m.cli_provider_login_option_provider_description())
    .action(providerLogin);
  provider
    .command('test <provider-id>')
    .description(m.cli_provider_test_description())
    .option('--url <url>', m.cli_provider_test_option_url_description())
    .action(providerTest);
  const plugin = program.command('plugin').description(m.cli_plugin_description());
  plugin
    .command('add <package>')
    .description(m.cli_plugin_add_description())
    .option('--yes', m.cli_plugin_add_option_yes_description())
    .option('--registry <url>', m.cli_plugin_add_option_registry_description())
    .action((packageName, options) => pluginAdd(packageName, options));
  plugin
    .command('list')
    .description(m.cli_plugin_list_description())
    .action(() => pluginList({}));
  plugin
    .command('config <package>')
    .description(m.cli_plugin_config_description())
    .option('--clear-secret <key...>', m.cli_plugin_config_option_clear_secret_description())
    .action((packageName, options) => pluginConfig(packageName, options));
  plugin
    .command('remove <package>')
    .description(m.cli_plugin_remove_description())
    .option('--purge-secrets', m.cli_plugin_remove_option_purge_secrets_description())
    .option('--yes', m.cli_plugin_remove_option_yes_description())
    .action((packageName, options) => pluginRemove(packageName, options));
  plugin
    .command('prune')
    .description(m.cli_plugin_prune_description())
    .option('--yes', m.cli_plugin_prune_option_yes_description())
    .action((options) => pluginPrune(options));
  registerServiceCommands(program);

  program
    .command('doctor')
    .description(m.cli_doctor_description())
    .option('--host <host>', m.cli_run_option_host_description())
    .option('--port <port>', m.cli_run_option_port_description())
    .action((options) => doctorCommand(options));

  program
    .command('completion <shell>')
    .description(m.cli_completion_description())
    .action((shell) => completionCommand(shell));

  return program;
};

export const main = async (deps: CliDeps = defaultCliDeps) => {
  try {
    void setLocale(resolveLocaleFromArgv(process.argv));
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
  if (isKnownCliUserError(err)) {
    return { message: err.message };
  }
  return formatUserError(err, locale);
}

if (import.meta.main) {
  await main();
}
