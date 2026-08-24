import { m } from '@aio-proxy/i18n';

export type ProxyMode = 'inherit' | 'disabled' | 'url';

export const proxyModeOf = (value: unknown): ProxyMode => {
  if (value === false) return 'disabled';
  if (typeof value === 'string') return 'url';
  return 'inherit';
};

export const proxyModeLabel = (value: unknown): string => {
  switch (proxyModeOf(value)) {
    case 'inherit':
      return m['dashboard.providers.form.proxy_inherit']();
    case 'disabled':
      return m['dashboard.providers.form.proxy_disabled']();
    case 'url':
      return m['dashboard.providers.form.proxy_url']();
  }
};

export const headerCountText = (count: number): string =>
  count === 1
    ? m['dashboard.providers.editor.hint_advanced_header']({ count })
    : m['dashboard.providers.editor.hint_advanced_headers']({ count });

export const transformRuleCountText = (count: number): string =>
  count === 0
    ? m['dashboard.providers.editor.advanced_transforms_none']()
    : count === 1
      ? m['dashboard.providers.editor.advanced_transforms_rule']({ count })
      : m['dashboard.providers.editor.advanced_transforms_rules']({ count });
