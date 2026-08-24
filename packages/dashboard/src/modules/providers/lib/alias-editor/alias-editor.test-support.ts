import type { AliasConfig } from '@aio-proxy/types';

import type { AliasRow } from './alias-editor';

export const alias = {
  mini: {
    model: 'gpt-default',
    preserve: false,
    variants: { low: { model: 'gpt-low', preserve: false } },
  },
};

/** The array form is equally valid config, and it is the shape the record form cannot express. */
export const thinkingAlias = {
  sonnet: {
    model: 'claude-sonnet-4',
    preserve: false,
    variants: [{ when: { thinking: true }, model: 'claude-sonnet-4-thinking', preserve: false }],
  },
};

export const aliasRow = (name: string, config: AliasConfig, id = name): AliasRow => ({ id, name, config });
