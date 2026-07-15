const SHELL_SAFE_ARGUMENT = /^[A-Za-z0-9_@%+,:./-]+$/u;

export function shellCommandArgument(value: string): string {
  if (SHELL_SAFE_ARGUMENT.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export const providerLoginCommand = (providerId: string): string =>
  `aio-proxy provider login --provider ${shellCommandArgument(providerId)}`;

export const pluginConfigCommand = (packageName: string): string =>
  `aio-proxy plugin config ${shellCommandArgument(packageName)}`;
