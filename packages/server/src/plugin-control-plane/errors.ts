export type PluginControlPlaneErrorCode =
  | 'already_installed'
  | 'builtin_plugin'
  | 'config_unavailable'
  | 'confirmation_required'
  | 'concurrent_update'
  | 'dependent_providers'
  | 'descriptor_invalid'
  | 'npm_install_failed'
  | 'npm_lock_failed'
  | 'options_invalid'
  | 'package_invalid'
  | 'plugin_not_found'
  | 'reload_failed'
  | 'setup_failed'
  | 'stale_revision';

export class PluginControlPlaneError extends Error {
  override name = 'PluginControlPlaneError';

  constructor(
    readonly code: PluginControlPlaneErrorCode,
    readonly status: 400 | 404 | 409 | 422 | 423 | 502,
  ) {
    super(code);
  }
}

export class PluginDependenciesError extends PluginControlPlaneError {
  constructor(readonly providerIds: readonly string[]) {
    super('dependent_providers', 409);
    this.name = 'PluginDependenciesError';
  }
}
