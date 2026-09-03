import { describe, expect, test } from 'bun:test';

import type { ServerLog } from '../server-log';
import { leftoverOAuthModelProviderIds, warnLeftoverOAuthModels } from './leftover-oauth-models';

describe('leftover OAuth models', () => {
  test('lists oauth entries that still author a models key', () => {
    expect(
      leftoverOAuthModelProviderIds({
        providers: {
          copilot: { kind: 'oauth', plugin: '@example/oauth', models: ['gpt-5'] },
          clean: { kind: 'oauth', plugin: '@example/oauth' },
          api: { kind: 'api', protocol: 'openai-compatible', models: ['gpt-5'] },
          broken: 'not-an-object',
        },
      }),
    ).toEqual(['copilot']);
  });

  test('ignores a missing or non-object providers map', () => {
    expect(leftoverOAuthModelProviderIds(undefined)).toEqual([]);
    expect(leftoverOAuthModelProviderIds({ providers: [] })).toEqual([]);
  });

  test('emits one startup warning per leftover oauth models key', () => {
    const logs: ServerLog[] = [];
    warnLeftoverOAuthModels(
      {
        providers: {
          first: { kind: 'oauth', models: ['a'] },
          second: { kind: 'oauth', models: [] },
          api: { kind: 'api', models: ['a'] },
        },
      },
      (entry) => logs.push(entry),
    );

    expect(logs).toEqual([
      { event: 'config.oauth_leftover_models', providerId: 'first' },
      { event: 'config.oauth_leftover_models', providerId: 'second' },
    ]);
  });
});
