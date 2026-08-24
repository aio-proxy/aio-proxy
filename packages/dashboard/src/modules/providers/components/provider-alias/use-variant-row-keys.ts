import { useState } from 'react';

type VariantRowKeys = { readonly keys: readonly string[]; readonly next: number };

const mint = (from: number, count: number): VariantRowKeys => ({
  keys: Array.from({ length: count }, (_, offset) => `variant-${from + offset}`),
  next: from + count,
});

/**
 * React keys for the variant rows. The stored index cannot be one: removing a row renumbers every row
 * after it, so React hands the removed row's component instance to whichever row shifted into its
 * place — along with the state that never reaches `row`, such as an open condition dropdown or DOM
 * focus. Keys are minted per stored position and then carried through edits, so identity follows the
 * row rather than the position, the way the alias ids above this list already do.
 */
export const useVariantRowKeys = (count: number) => {
  const [state, setState] = useState<VariantRowKeys>(() => mint(0, count));

  // The alias can also change from outside this list — a reset, or a reload of the whole config. There
  // is nothing to map those rows onto the old keys, so identity restarts instead of drifting by one.
  if (state.keys.length !== count) setState(mint(state.next, count));

  return {
    keys: state.keys,
    appendKey: () =>
      setState((current) => ({ keys: [...current.keys, `variant-${current.next}`], next: current.next + 1 })),
    dropKey: (index: number) =>
      setState((current) => ({ ...current, keys: current.keys.filter((_, position) => position !== index) })),
  };
};
