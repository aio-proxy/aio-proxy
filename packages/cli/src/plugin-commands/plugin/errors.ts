import { m } from "@aio-proxy/i18n";

export class PluginConfirmationRequiredError extends Error {
  override readonly name = "PluginConfirmationRequiredError";
  constructor(readonly packageName?: string) {
    super(
      packageName === undefined
        ? m.cli_plugin_error_confirmation_required()
        : m.cli_plugin_error_confirmation_required_for({ plugin: packageName }),
    );
  }
}

export class PluginTrustRejectedError extends Error {
  override readonly name = "PluginTrustRejectedError";
  constructor() {
    super(m.cli_plugin_error_cancelled());
  }
}

export class PluginDescriptorInvalidError extends Error {
  override readonly name = "PluginDescriptorInvalidError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_descriptor_invalid({ plugin: packageName }));
  }
}

export class PluginNotConfiguredError extends Error {
  override readonly name = "PluginNotConfiguredError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_not_configured({ plugin: packageName }));
  }
}

export class PluginNotInstalledError extends Error {
  override readonly name = "PluginNotInstalledError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_not_installed({ plugin: packageName }));
  }
}

export class PluginConfigChangedError extends Error {
  override readonly name = "PluginConfigChangedError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_config_changed({ plugin: packageName }));
  }
}

export class BuiltInPluginRemovalError extends Error {
  override readonly name = "BuiltInPluginRemovalError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_builtin_remove({ plugin: packageName }));
  }
}

export class PluginSecretPurgeConflictError extends Error {
  override readonly name = "PluginSecretPurgeConflictError";
  constructor(readonly packageName: string) {
    super(m.cli_plugin_error_purge_conflict({ plugin: packageName }));
  }
}

export class PluginSetupValidationError extends Error {
  override readonly name = "PluginSetupValidationError";
  constructor(
    readonly packageName: string,
    summary: string,
  ) {
    super(summary);
  }
}

export const pluginErrors = [
  PluginConfirmationRequiredError,
  PluginTrustRejectedError,
  PluginDescriptorInvalidError,
  PluginNotConfiguredError,
  PluginNotInstalledError,
  PluginConfigChangedError,
  BuiltInPluginRemovalError,
  PluginSecretPurgeConflictError,
  PluginSetupValidationError,
] as const;
