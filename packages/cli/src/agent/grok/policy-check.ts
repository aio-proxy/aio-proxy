import { isPlainObject } from 'es-toolkit/predicate';

import type { GrokPolicySource, GrokVisiblePolicy } from './types';

const UNVERIFIABLE = 'Grok visible policy unverifiable';
const AUTH_LABEL = 'AIO Proxy';
const AUTH_HEADER = 'authorization';

type FieldSpec = {
  readonly env: string;
  readonly paths: readonly (readonly string[])[];
  readonly desired: (endpoint: string, command: string) => string;
};

const MANAGED_FIELDS: readonly FieldSpec[] = [
  {
    env: 'GROK_MODELS_BASE_URL',
    paths: [['endpoints', 'models_base_url']],
    desired: (endpoint) => `${endpoint}/v1`,
  },
  {
    env: 'GROK_MODELS_LIST_URL',
    paths: [
      ['endpoints', 'models_list_url'],
      ['endpoints', 'models_endpoint'],
    ],
    desired: (endpoint) => `${endpoint}/v1/models`,
  },
  {
    env: 'GROK_CLI_CHAT_PROXY_BASE_URL',
    paths: [['endpoints', 'cli_chat_proxy_base_url']],
    desired: (endpoint) => endpoint,
  },
  {
    env: 'GROK_XAI_API_BASE_URL',
    paths: [['endpoints', 'xai_api_base_url']],
    desired: (endpoint) => `${endpoint}/v1`,
  },
  {
    env: 'GROK_MANAGED_CONFIG_URL',
    paths: [['endpoints', 'managed_config_url']],
    desired: (endpoint) => `${endpoint}/__grok_unavailable/managed-config`,
  },
  {
    env: 'GROK_AUTH_PROVIDER_COMMAND',
    paths: [
      ['auth', 'auth_provider_command'],
      ['grok_com_config', 'auth_provider_command'],
    ],
    desired: (_endpoint, command) => command,
  },
  {
    env: 'GROK_AUTH_PROVIDER_LABEL',
    paths: [
      ['auth', 'auth_provider_label'],
      ['grok_com_config', 'auth_provider_label'],
    ],
    desired: () => AUTH_LABEL,
  },
];

const asObject = (value: unknown): Record<string, unknown> | undefined => (isPlainObject(value) ? value : undefined);

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const lookup = (root: unknown, path: readonly string[]): unknown => {
  let current: unknown = root;
  for (const part of path) {
    const object = asObject(current);
    if (object === undefined) return undefined;
    current = object[part];
  }
  return current;
};

const parseSource = (source: GrokPolicySource): unknown => {
  try {
    return source.kind === 'json' ? JSON.parse(source.text) : Bun.TOML.parse(source.text);
  } catch {
    throw new Error(UNVERIFIABLE);
  }
};

const isRequirements = (path: string): boolean => path.endsWith('requirements.toml') || path === 'ai.x.grok';
const isManaged = (path: string): boolean => path.endsWith('managed_config.toml');
const isOverlay = (path: string): boolean => !isManaged(path) && !isRequirements(path);
const valuesIn = (
  parsed: readonly { readonly path: string; readonly value: unknown }[],
  match: (path: string) => boolean,
): unknown[] => parsed.filter((source) => match(source.path)).map((source) => source.value);

const firstString = (
  root: unknown,
  paths: readonly (readonly string[])[],
): { path: string; value: string } | undefined => {
  for (const path of paths) {
    const value = asString(lookup(root, path));
    if (value !== undefined) return { path: path.join('.'), value };
  }
  return undefined;
};

const sourcedField = (
  parsed: readonly { readonly path: string; readonly value: unknown }[],
  paths: readonly (readonly string[])[],
  match: (path: string) => boolean,
): { path: string; value: string } | undefined => {
  let found: { path: string; value: string } | undefined;
  for (const source of parsed) {
    if (!match(source.path)) continue;
    const field = firstString(source.value, paths);
    if (field !== undefined) found = field;
  }
  return found;
};

const originOf = (value: string): string | undefined => {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
};

const hasAuthorization = (headers: unknown): string | undefined => {
  const object = asObject(headers);
  if (object === undefined) return undefined;
  return Object.keys(object).find((key) => key.toLowerCase() === AUTH_HEADER);
};

const teamPresent = (value: unknown): boolean => {
  if (typeof value === 'string') return value !== '';
  return Array.isArray(value);
};

const namedTables = (root: unknown, section: string): Record<string, Record<string, unknown>> => {
  const table = asObject(lookup(root, [section]));
  if (table === undefined) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [id, spec] of Object.entries(table)) {
    const object = asObject(spec);
    if (object === undefined) continue;
    result[id] = object;
  }
  return result;
};

const mergeNamed = (layers: readonly unknown[], section: string): Record<string, Record<string, unknown>> => {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const layer of layers) {
    for (const [id, spec] of Object.entries(namedTables(layer, section))) {
      merged[id] = { ...merged[id], ...spec };
    }
  }
  return merged;
};

const pushUnique = (conflicts: string[], path: string): void => {
  if (!conflicts.includes(path)) conflicts.push(path);
};

const checkUrls = (
  tables: Record<string, Record<string, unknown>>,
  section: string,
  expectedOrigin: string,
  conflicts: string[],
): void => {
  for (const [id, spec] of Object.entries(tables)) {
    for (const key of ['base_url', 'api_base_url'] as const) {
      const value = asString(spec[key]);
      if (value === undefined) continue;
      if (originOf(value) !== expectedOrigin) pushUnique(conflicts, `${section}.${id}.${key}`);
    }
  }
};

const checkModelAuth = (tables: Record<string, Record<string, unknown>>, conflicts: string[]): void => {
  for (const [id, spec] of Object.entries(tables)) {
    for (const key of ['api_key', 'env_key', 'auth_provider'] as const) {
      if (spec[key] !== undefined) pushUnique(conflicts, `model.${id}.${key}`);
    }
    for (const key of ['extra_headers', 'env_http_headers'] as const) {
      const header = hasAuthorization(spec[key]);
      if (header !== undefined) pushUnique(conflicts, `model.${id}.${key}.${header}`);
    }
  }
};

const checkTeamAndRelay = (
  layers: readonly unknown[],
  env: Readonly<Record<string, string | undefined>>,
  expectedOrigin: string,
  conflicts: string[],
): void => {
  const teamEnv = env['GROK_FORCE_LOGIN_TEAM_ID'];
  if (teamEnv !== undefined && teamEnv !== '') pushUnique(conflicts, 'auth.force_login_team_uuid');
  const relayEnv = env['GROK_WS_URL'];
  if (relayEnv !== undefined && relayEnv !== '' && originOf(relayEnv) !== expectedOrigin) {
    pushUnique(conflicts, 'auth.grok_ws_url');
  }
  for (const layer of layers) {
    for (const table of ['auth', 'grok_com_config'] as const) {
      if (teamPresent(lookup(layer, [table, 'force_login_team_uuid']))) {
        pushUnique(conflicts, `${table}.force_login_team_uuid`);
      }
      const relay = asString(lookup(layer, [table, 'grok_ws_url']));
      if (relay !== undefined && originOf(relay) !== expectedOrigin) pushUnique(conflicts, `${table}.grok_ws_url`);
    }
  }
};

export function checkGrokPolicy(
  text: string,
  endpoint: string,
  command: string,
  policy: GrokVisiblePolicy,
): readonly string[] {
  let user: unknown;
  try {
    user = text === '' ? {} : Bun.TOML.parse(text);
  } catch {
    throw new Error(UNVERIFIABLE);
  }
  const parsed = policy.sources.map((source) => ({ path: source.path, value: parseSource(source) }));
  const layers = [
    ...valuesIn(parsed, isManaged),
    user,
    ...valuesIn(parsed, (path) => !isManaged(path) && !isRequirements(path)),
    ...valuesIn(parsed, isRequirements),
  ];
  const expectedOrigin = originOf(endpoint);
  if (expectedOrigin === undefined) throw new Error('invalid endpoint');
  const conflicts: string[] = [];

  for (const field of MANAGED_FIELDS) {
    const desired = field.desired(endpoint, command);
    const pin = sourcedField(parsed, field.paths, isRequirements);
    if (pin !== undefined) {
      if (pin.value !== desired) pushUnique(conflicts, pin.path);
      continue;
    }
    const envValue = policy.env[field.env];
    if (envValue !== undefined && envValue !== '') {
      if (envValue !== desired) pushUnique(conflicts, field.paths[0]!.join('.'));
      continue;
    }
    const overlay = sourcedField(parsed, field.paths, isOverlay);
    if (overlay !== undefined && overlay.value !== desired) {
      pushUnique(conflicts, overlay.path);
    }
  }

  const models = mergeNamed(layers, 'model');
  checkUrls(models, 'model', expectedOrigin, conflicts);
  checkModelAuth(models, conflicts);
  checkUrls(mergeNamed(layers, 'model_providers'), 'model_providers', expectedOrigin, conflicts);

  const globalHeaders = hasAuthorization(lookup(user, ['models', 'extra_headers']));
  if (globalHeaders !== undefined) pushUnique(conflicts, `models.extra_headers.${globalHeaders}`);
  for (const layer of parsed) {
    const header = hasAuthorization(lookup(layer.value, ['models', 'extra_headers']));
    if (header !== undefined) pushUnique(conflicts, `models.extra_headers.${header}`);
  }

  checkTeamAndRelay(layers, policy.env, expectedOrigin, conflicts);
  return conflicts;
}
