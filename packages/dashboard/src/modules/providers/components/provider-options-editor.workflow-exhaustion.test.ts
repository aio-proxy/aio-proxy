import { describe, expect, test } from '@rstest/core';

import {
  initialProviderOptionsSchemaState,
  providerOptionsSchemaTransition,
} from '../hooks/use-provider-options-schema';

describe('provider options schema workflow attempt exhaustion', () => {
  test('trusted package still missing after one automatic attempt enters an explicit error', () => {
    const committed = providerOptionsSchemaTransition(initialProviderOptionsSchemaState, {
      type: 'package_committed',
      packageName: '@ai-sdk/openai',
    });
    const missing = providerOptionsSchemaTransition(committed, {
      type: 'status_loaded',
      packageName: '@ai-sdk/openai',
      generation: 1,
      status: { trusted: true, state: 'missing' },
    });
    const installing = providerOptionsSchemaTransition(missing, { type: 'install_started' });
    const checking = providerOptionsSchemaTransition(installing, {
      type: 'install_succeeded',
      packageName: '@ai-sdk/openai',
      generation: 1,
    });

    expect(
      providerOptionsSchemaTransition(checking, {
        type: 'status_loaded',
        packageName: '@ai-sdk/openai',
        generation: 1,
        status: { trusted: true, state: 'missing' },
      }),
    ).toMatchObject({
      phase: 'install_error',
      automaticInstallAttempted: true,
      effect: undefined,
      errorCode: 'package_still_missing',
    });
  });
});
