import { describe, expect, test } from 'bun:test';

import { definePlugin } from '@aio-proxy/plugin-sdk';

import type { DiagnosticFactory } from '.';
import { redactPluginError } from '.';
import { loadPluginRegistry } from '../loader/index';

describe('redactPluginError', () => {
  test('malicious error accessors and string conversion use a fixed safe fallback', () => {
    const accessorError = Object.create(Error.prototype, {
      name: {
        get: () => {
          throw new Error('name getter leaked');
        },
      },
      message: {
        get: () => {
          throw new Error('message getter leaked');
        },
      },
      stack: {
        get: () => {
          throw new Error('stack getter leaked');
        },
      },
    });
    const stringError = {
      [Symbol.toPrimitive]() {
        throw new Error('string conversion leaked');
      },
    };

    expect(redactPluginError(accessorError)).toEqual({
      name: 'Error',
      message: 'Plugin error details unavailable',
    });
    expect(redactPluginError(stringError)).toEqual({
      name: 'Error',
      message: 'Plugin error details unavailable',
    });
  });

  test('loader diagnostics never receive raw plugin error details', async () => {
    const secret = 'public-diagnostic-secret';
    let capturedCode: unknown;
    let capturedOptions: unknown;
    const diagnostics: DiagnosticFactory = (code, options) => {
      capturedCode = code;
      capturedOptions = options;
      return {
        code,
        retryable: options.retryable,
        summary: code,
        occurredAt: new Date(0).toISOString(),
      };
    };
    const error = new Error(`Bearer ${secret}`, { cause: new Error('private cause') });
    error.stack = `Error: Bearer ${secret}\n at plugin (plugin.ts:1:1)`;
    const descriptor = definePlugin<unknown>(() => {
      throw error;
    });

    const snapshot = await loadPluginRegistry({
      enablements: [],
      builtIns: [{ packageName: '@example/public-diagnostic', version: '1.0.0', descriptor }],
      diagnostics,
      importPackage: async () => {
        throw new Error('must not import');
      },
      logger: () => {},
      secrets: { readPluginSecret: () => undefined },
    });
    const serialized = JSON.stringify(snapshot.plugins.get('@example/public-diagnostic')?.state);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('private cause');
    expect(serialized).not.toContain('stack');
    expect(serialized).toContain('PLUGIN_LOAD_FAILED');
    expect(capturedCode).toBe('PLUGIN_LOAD_FAILED');
    expect(capturedOptions).toEqual({ plugin: '@example/public-diagnostic', retryable: false });
    expect(JSON.stringify(capturedOptions)).not.toContain(secret);
    expect(JSON.stringify(capturedOptions)).not.toContain('cause');
    expect(JSON.stringify(capturedOptions)).not.toContain('stack');
    expect(Object.keys(capturedOptions as object).sort()).toEqual(['plugin', 'retryable']);
  });
});
