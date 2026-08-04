import { describe, expect, test } from 'bun:test';

import type { ZodType } from 'zod';

import * as dashboard from '../index';

const schema = (name: string): ZodType => {
  expect(dashboard).toHaveProperty(name);
  return Reflect.get(dashboard, name) as ZodType;
};

const settings = {
  host: '127.0.0.1',
  port: 9317,
  proxy: 'https://proxy.example',
  logging: { enabled: true, retentionDays: 14, level: 'info' },
  retryAfterCapMs: 30_000,
  hasPassword: true,
} as const;

describe('dashboard settings control-plane contracts', () => {
  test('distinguishes preserving, deleting, and replacing the authored root proxy', () => {
    const mutation = schema('DashboardSettingsMutationSchema');

    expect(mutation.parse({})).toEqual({});
    expect(mutation.parse({ proxy: null })).toEqual({ proxy: null });
    expect(mutation.parse({ proxy: 'https://proxy.example' })).toEqual({ proxy: 'https://proxy.example' });
    expect(mutation.parse({ proxy: 'https://{{env.PROXY_HOST}}:8080' })).toEqual({
      proxy: 'https://{{env.PROXY_HOST}}:8080',
    });
    expect(mutation.parse({ proxy: 'http://proxy.example:{{env.PROXY_PORT}}' })).toEqual({
      proxy: 'http://proxy.example:{{env.PROXY_PORT}}',
    });
    expect(mutation.parse({ proxy: 'http://[{{env.PROXY_IPV6}}]:{{env.PROXY_PORT}}' })).toEqual({
      proxy: 'http://[{{env.PROXY_IPV6}}]:{{env.PROXY_PORT}}',
    });
    expect(mutation.parse({ proxy: 'https://{{ env.PROXY_HOST }}' })).toEqual({
      proxy: 'https://{{ env.PROXY_HOST }}',
    });
  });

  test('rejects unsupported proxies and server-unowned settings', () => {
    const mutation = schema('DashboardSettingsMutationSchema');

    for (const proxy of [
      'socks5://localhost:1080',
      'proxy.example',
      'socks5://{{env.HOST}}',
      'not-a-proxy {{env.X}}',
      'https://{{! comment}}',
      'https://{{foo}}',
    ]) {
      expect(mutation.safeParse({ proxy }).success).toBe(false);
    }
    for (const field of ['theme', 'language', 'router', 'password', 'hasPassword']) {
      expect(mutation.safeParse({ [field]: field === 'router' ? {} : 'value' }).success).toBe(false);
    }
  });

  test('accepts only credential-free or fully redacted root proxies in the settings view', () => {
    const view = schema('DashboardSettingsViewSchema');

    expect(view.parse(settings)).toEqual(settings);
    expect(view.parse({ ...settings, proxy: '****' })).toEqual({ ...settings, proxy: '****' });
    expect(view.safeParse({ ...settings, password: 'secret' }).success).toBe(false);
    expect(view.safeParse({ ...settings, proxy: 'https://user:secret@proxy.example' }).success).toBe(false);
    expect(view.safeParse({ ...settings, proxy: '{{env.HTTPS_PROXY}}' }).success).toBe(false);
  });

  test('reports whether a successful settings write requires restart', () => {
    const response = schema('DashboardSettingsMutationResponseSchema');

    expect(response.parse({ ok: true, settings, restartRequired: true })).toEqual({
      ok: true,
      settings,
      restartRequired: true,
    });
    expect(response.parse({ ok: false, error: { code: 'reload_failed' } })).toEqual({
      ok: false,
      error: { code: 'reload_failed' },
    });
  });
});

const pluginForm = [
  { type: 'text', key: 'region', label: 'Region' },
  { type: 'secret', key: 'token', label: 'Token', configured: true },
] as const;

describe('dashboard plugin control-plane contracts', () => {
  test('keeps plugin summaries free of option values and descriptor internals', () => {
    const summary = schema('DashboardPluginSummarySchema');
    const value = {
      packageName: '@example/plugin',
      version: '1.2.3',
      builtin: false,
      enabled: true,
      state: { status: 'ready' },
      hasOptions: true,
    } as const;

    expect(summary.parse(value)).toEqual(value);
    for (const field of ['options', 'config', 'setup', 'secrets']) {
      expect(summary.safeParse({ ...value, [field]: field === 'setup' ? () => {} : {} }).success).toBe(false);
    }
  });

  test('separates public option values from secret configured indicators in the edit view', () => {
    const editView = schema('DashboardPluginEditViewSchema');
    const value = {
      packageName: '@example/plugin',
      form: pluginForm,
      publicValues: { region: 'us-east-1' },
      revision: 'sha256:current',
    } as const;

    expect(editView.parse(value)).toEqual(value);
    expect(editView.safeParse({ ...value, form: [{ ...pluginForm[1], value: 'secret' }] }).success).toBe(false);
    expect(editView.safeParse({ ...value, publicValues: { token: 'secret' } }).success).toBe(false);
  });

  test('accepts scoped package mutations and rejects raw options or serialized current secrets', () => {
    const mutation = schema('DashboardPluginOptionsMutationSchema');
    const value = {
      packageName: '@example/plugin',
      revision: 'sha256:current',
      publicValues: { region: 'eu-west-1' },
      secretValues: { token: 'replacement' },
      clearSecretKeys: ['oldToken'],
    } as const;

    expect(mutation.parse(value)).toEqual(value);
    expect(mutation.safeParse({ ...value, packageName: '@Example/plugin' }).success).toBe(false);
    expect(mutation.safeParse({ ...value, options: { token: 'secret' } }).success).toBe(false);
    expect(mutation.safeParse({ ...value, currentSecrets: { token: 'secret' } }).success).toBe(false);
  });
});
