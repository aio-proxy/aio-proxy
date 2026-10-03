import { describe, expect, test } from 'bun:test';

import { DiagnosticSchema } from '@aio-proxy/types';

import { createPluginDiagnosticFactory } from '.';

describe('createPluginDiagnosticFactory', () => {
  test('centralizes localized summaries, safe identifiers, and injected timestamps', () => {
    const diagnostic = createPluginDiagnosticFactory(() => 123)('CAPABILITY_MISSING', {
      plugin: 'not a package secret-plugin',
      capability: 'secret capability',
      providerId: 'provider',
      retryable: false,
      suggestedCommand: 'aio-proxy provider login',
    });

    expect(diagnostic).toEqual({
      code: 'CAPABILITY_MISSING',
      occurredAt: new Date(123).toISOString(),
      retryable: false,
      suggestedCommand: 'aio-proxy provider login',
      summary: 'Plugin <plugin> does not provide capability <capability>',
    });
    expect(diagnostic.summary).not.toContain('secret');
  });

  test('renders proxy rejection with the provider ID only', () => {
    const diagnostic = createPluginDiagnosticFactory(() => 123)('PROXY_UNSUPPORTED', {
      plugin: '@aio-proxy/plugin-cursor',
      capability: 'default',
      providerId: 'cursor-personal',
      retryable: false,
    });

    expect(diagnostic).toEqual({
      code: 'PROXY_UNSUPPORTED',
      occurredAt: new Date(123).toISOString(),
      retryable: false,
      summary: 'Provider cursor-personal does not support the configured proxy',
    });
  });

  test('explains why syncModels cannot be used for an unsupported catalog', () => {
    const diagnostic = createPluginDiagnosticFactory(() => 123)('CATALOG_UNSUPPORTED', {
      providerId: 'upstream',
      retryable: false,
    });

    expect(diagnostic.summary).toBe('Provider upstream cannot list its upstream models, so syncModels cannot be used');
    expect(diagnostic.retryable).toBe(false);
    expect(DiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
  });
});
