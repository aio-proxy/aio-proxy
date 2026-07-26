import { describe, expect, test } from 'bun:test';

import { PluginSchemaContractError, parsePluginSchema } from '../../src/plugins/schema';

describe('parsePluginSchema', () => {
  test.each([
    [
      'schema method proxy',
      () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error('schema-proxy-secret');
            },
          },
        ),
      'schema-proxy-secret',
    ],
    [
      'result success getter',
      () => ({
        safeParse() {},
        async safeParseAsync() {
          return Object.defineProperty({}, 'success', {
            get() {
              throw new Error('success-getter-secret');
            },
          });
        },
      }),
      'success-getter-secret',
    ],
    [
      'result error getter',
      () => ({
        safeParse() {},
        async safeParseAsync() {
          return Object.defineProperty({ success: false }, 'error', {
            get() {
              throw new Error('error-getter-secret');
            },
          });
        },
      }),
      'error-getter-secret',
    ],
    [
      'error issues getter',
      () => ({
        safeParse() {},
        async safeParseAsync() {
          const error = Object.defineProperty({}, 'issues', {
            get() {
              throw new Error('issues-getter-secret');
            },
          });
          return { success: false, error };
        },
      }),
      'issues-getter-secret',
    ],
    [
      'issue message getter',
      () => ({
        safeParse() {},
        async safeParseAsync() {
          const issue = Object.defineProperty({ path: [] }, 'message', {
            get() {
              throw new Error('message-getter-secret');
            },
          });
          return { success: false, error: { issues: [issue] } };
        },
      }),
      'message-getter-secret',
    ],
    [
      'issue path getter',
      () => ({
        safeParse() {},
        async safeParseAsync() {
          const issue = Object.defineProperty({ message: 'bad' }, 'path', {
            get() {
              throw new Error('path-getter-secret');
            },
          });
          return { success: false, error: { issues: [issue] } };
        },
      }),
      'path-getter-secret',
    ],
  ])('%s throws only the fixed contract error', async (_name, createSchema, leakedSecret) => {
    try {
      await parsePluginSchema(createSchema() as never, 'hidden-input');
      throw new Error('expected parsePluginSchema to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginSchemaContractError);
      expect(String(error)).not.toContain(leakedSecret);
      expect(error).not.toHaveProperty('cause');
    }
  });
});
