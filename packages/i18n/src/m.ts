import * as generated from './paraglide/messages/_index.js';

type Messages = typeof generated;

export const m: Messages = new Proxy(generated, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && !Reflect.has(target, prop)) {
      const underscored = prop.replaceAll('.', '_');
      if (Reflect.has(target, underscored)) return Reflect.get(target, underscored, receiver);
    }
    return Reflect.get(target, prop, receiver);
  },
}) as Messages;
