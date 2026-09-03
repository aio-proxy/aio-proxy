import { describe, expect, test } from '@rstest/core';

import { alias, thinkingAlias } from '../alias-editor/alias-editor.test-support';
import { applicablePluginAliases } from './plugin-alias-suggestions';

const config = (model: string) => ({ model, preserve: false });

describe('applicablePluginAliases', () => {
  test('drops a whole suggestion when any target, variant included, is outside the exposed set', () => {
    expect(
      applicablePluginAliases({ ...alias, sonnet: thinkingAlias.sonnet }, [
        'gpt-default',
        'gpt-low',
        'claude-sonnet-4',
      ]),
    ).toEqual(alias);
    expect(applicablePluginAliases(thinkingAlias, ['claude-sonnet-4'])).toBeUndefined();
  });

  test('skips target filtering for an empty exposed set while still normalizing keys', () => {
    expect(applicablePluginAliases({ ' mini': config('model-a'), '   ': config('model-b') }, [])).toEqual({
      mini: config('model-a'),
    });
    expect(applicablePluginAliases(undefined, ['model-a'])).toBeUndefined();
  });
});
