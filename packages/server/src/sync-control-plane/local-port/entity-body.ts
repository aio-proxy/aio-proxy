import type { EntityBody, SyncRepository } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';

export function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

// A Provider ID or model name is user data, so it can be `__proto__`. Plain assignment would reach
// the legacy prototype setter instead of creating an own property, and the entry would vanish from
// the serialized config while the sync baseline still advanced past the revision.
function setKey(target: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

// The allowlists projectCommitted publishes for these kinds. A shared body always carries the
// complete set, so a key the body omits was deleted on the other device and must be deleted here
// too — spreading the body would silently keep a revoked password or API key working.
const SERVICE_ACCESS_KEYS = ['apiKeys', 'password'] as const;
const ROUTING_DEFAULTS_SERVER_KEYS = ['retry'] as const;
const ROUTING_DEFAULTS_ROUTER_KEYS = ['modelContextAggregation'] as const;

function replaceKeys(
  target: Record<string, JsonValue>,
  value: Record<string, JsonValue>,
  keys: readonly string[],
): Record<string, JsonValue> {
  for (const key of keys) {
    if (Object.hasOwn(value, key)) setKey(target, key, value[key]!);
    else delete target[key];
  }
  return target;
}

/**
 * A published model rule carries only the Providers the other device included, so installing or
 * deleting one verbatim would drop this device's routes to Providers it kept local. `projectCommitted`
 * re-derives the local remainder from the result, so a route lost here is lost for good. Returns
 * `undefined` when the rule holds nothing local and the shared portion is gone.
 */
function mergeLocalRoutes(
  previous: JsonValue | undefined,
  shared: JsonValue | undefined,
  entities: ReturnType<SyncRepository['entities']>,
): JsonValue | undefined {
  const included = new Set(
    entities.filter((entity) => entity.kind === 'provider' && entity.mode === 'included').map((e) => e.logicalKey),
  );
  const local = Object.entries(record(record(previous)['providers'])).filter(([id]) => !included.has(id));
  if (local.length === 0) return shared;
  const base = record(shared);
  return { ...base, providers: { ...record(base['providers']), ...Object.fromEntries(local) } };
}

export function applyBody(
  raw: Record<string, JsonValue>,
  body: EntityBody | null,
  entities: ReturnType<SyncRepository['entities']>,
): Record<string, JsonValue> {
  const next = structuredClone(raw);
  if (body === null) return next;
  switch (body.kind) {
    case 'provider': {
      const providers = record(next['providers']);
      const previous = record(providers[body.logicalKey]);
      const value = record(body.value);
      // sharedProvider strips `proxy` before publishing, so it stays device-local. Replacing the
      // whole Provider on a remote revision would wipe the authored proxy and its URL credentials.
      setKey(
        providers,
        body.logicalKey,
        Object.hasOwn(previous, 'proxy') ? { ...value, proxy: previous['proxy']! } : body.value,
      );
      next['providers'] = providers;
      break;
    }
    case 'model-rule': {
      const router = record(next['router']);
      const models = record(router['models']);
      setKey(models, body.logicalKey, mergeLocalRoutes(models[body.logicalKey], body.value, entities) ?? body.value);
      router['models'] = models;
      next['router'] = router;
      break;
    }
    case 'plugin-business': {
      const plugins = Array.isArray(next['plugins']) ? [...next['plugins']] : [];
      const index = plugins.findIndex((entry) => {
        if (typeof entry === 'string') return entry === body.logicalKey;
        return Array.isArray(entry) && entry[0] === body.logicalKey;
      });
      const value = record(body.value);
      const options = value['options'];
      const entry = options === undefined ? body.logicalKey : [body.logicalKey, options];
      if (index < 0) plugins.push(entry);
      else plugins[index] = entry;
      next['plugins'] = plugins as JsonValue;
      break;
    }
    case 'service-access': {
      next['server'] = replaceKeys(record(next['server']), record(body.value), SERVICE_ACCESS_KEYS);
      break;
    }
    case 'routing-defaults': {
      const value = record(body.value);
      next['server'] = replaceKeys(record(next['server']), value, ROUTING_DEFAULTS_SERVER_KEYS);
      next['router'] = replaceKeys(record(next['router']), value, ROUTING_DEFAULTS_ROUTER_KEYS);
      break;
    }
  }
  return next;
}

export function removeBody(
  raw: Record<string, JsonValue>,
  entity: ReturnType<SyncRepository['entities']>[number],
  entities: ReturnType<SyncRepository['entities']>,
): Record<string, JsonValue> {
  const next = structuredClone(raw);
  switch (entity.kind) {
    case 'provider': {
      const providers = record(next['providers']);
      delete providers[entity.logicalKey];
      next['providers'] = providers;
      break;
    }
    case 'model-rule': {
      const router = record(next['router']);
      const models = record(router['models']);
      const kept = mergeLocalRoutes(models[entity.logicalKey], undefined, entities);
      if (kept === undefined) delete models[entity.logicalKey];
      else setKey(models, entity.logicalKey, kept);
      router['models'] = models;
      next['router'] = router;
      break;
    }
    case 'plugin-business': {
      if (Array.isArray(next['plugins'])) {
        next['plugins'] = next['plugins'].filter((entry) => {
          const name = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : undefined;
          return name !== entity.logicalKey;
        });
      }
      break;
    }
    case 'service-access': {
      next['server'] = replaceKeys(record(next['server']), {}, SERVICE_ACCESS_KEYS);
      break;
    }
    case 'routing-defaults': {
      next['server'] = replaceKeys(record(next['server']), {}, ROUTING_DEFAULTS_SERVER_KEYS);
      next['router'] = replaceKeys(record(next['router']), {}, ROUTING_DEFAULTS_ROUTER_KEYS);
      break;
    }
  }
  return next;
}
