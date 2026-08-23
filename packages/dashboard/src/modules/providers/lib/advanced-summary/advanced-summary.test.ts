import { m } from '@aio-proxy/i18n';
import { expect, test } from '@rstest/core';

import { headerCountText, proxyModeLabel, transformRuleCountText } from './advanced-summary';

test('proxyModeLabel names inherit, disabled, and url from the raw form value', () => {
  expect(proxyModeLabel(null)).toBe(m['dashboard.providers.form.proxy_inherit']());
  expect(proxyModeLabel(false)).toBe(m['dashboard.providers.form.proxy_disabled']());
  expect(proxyModeLabel('http://127.0.0.1:7890')).toBe(m['dashboard.providers.form.proxy_url']());
});

test('transformRuleCountText uses none at zero and the plural key otherwise', () => {
  expect(transformRuleCountText(0)).toBe(m['dashboard.providers.editor.advanced_transforms_none']());
  expect(transformRuleCountText(2)).toBe(m['dashboard.providers.editor.advanced_transforms_rules']({ count: 2 }));
});

test('headerCountText keeps the singular and plural keys apart', () => {
  expect(headerCountText(1)).toBe(m['dashboard.providers.editor.hint_advanced_header']({ count: 1 }));
  expect(headerCountText(2)).toBe(m['dashboard.providers.editor.hint_advanced_headers']({ count: 2 }));
});
