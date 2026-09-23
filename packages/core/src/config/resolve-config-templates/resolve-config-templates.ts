import { renderTemplate } from '@aio-proxy/plugin-sdk';
import { mapValues } from 'es-toolkit/object';
import { isPlainObject } from 'es-toolkit/predicate';

type Environment = Readonly<Record<string, string | undefined>>;

export function resolveConfigTemplates(value: unknown, env: Environment = process.env): unknown {
  if (!isPlainObject(value)) return resolveValue(value, env, false);
  return mapValues(value, (child, key) => {
    if (key !== 'plugins' || !Array.isArray(child)) return resolveValue(child, env, false);
    return child.map((entry) =>
      Array.isArray(entry)
        ? entry.map((part, index) => resolveValue(part, env, index === 1))
        : resolveValue(entry, env, false),
    );
  });
}

/** Resolve env references before validating plugin options, retaining simple
 * plugin variables for the plugin to validate and evaluate at request time. */
export function resolvePluginOptionsTemplates(value: unknown, env: Environment = process.env): unknown {
  return resolveValue(value, env, true);
}

function resolveValue(value: unknown, env: Environment, pluginOptions: boolean): unknown {
  if (typeof value === 'string') {
    try {
      return renderTemplate(value, (name) => {
        if (/^env\.[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
          const key = name.slice(4);
          return Object.hasOwn(env, key) && typeof env[key] === 'string' ? env[key] : '';
        }
        if (pluginOptions && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return `{{${name}}}`;
        throw new TypeError('Unsupported config template');
      });
    } catch {
      throw new TypeError('Unsupported config template');
    }
  }
  if (Array.isArray(value)) return value.map((child) => resolveValue(child, env, pluginOptions));
  return isPlainObject(value) ? mapValues(value, (child) => resolveValue(child, env, pluginOptions)) : value;
}
