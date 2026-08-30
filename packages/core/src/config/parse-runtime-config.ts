import { type Config, ConfigSchema } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import { resolveConfigTemplates } from './resolve-config-templates';

const digitPort = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
};

const withDigitServerPort = (value: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const server = value['server'];
  if (!isPlainObject(server)) return value;
  const port = digitPort(server['port']);
  return port === undefined ? value : { ...value, server: { ...server, port } };
};

export function parseRuntimeConfig(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  return ConfigSchema.parse(withDigitServerPort(resolveConfigTemplates(value, env)));
}
