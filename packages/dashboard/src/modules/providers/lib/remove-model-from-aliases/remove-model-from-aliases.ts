import { flattenAliasVariants } from '@aio-proxy/types';

import { type AliasRow, toAliasVariants } from '../alias-editor';

export const removeModelFromAliases = (rows: readonly AliasRow[], modelId: string): readonly AliasRow[] =>
  rows.flatMap((row) => {
    if (row.config.model === modelId) return [];
    const variants = toAliasVariants(
      flattenAliasVariants(row.config.variants).filter((item) => item.model !== modelId),
    );
    return [
      {
        ...row,
        config:
          variants === undefined
            ? { model: row.config.model, preserve: row.config.preserve }
            : { model: row.config.model, preserve: row.config.preserve, variants },
      },
    ];
  });
