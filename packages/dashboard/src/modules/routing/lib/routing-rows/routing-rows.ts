import type { DashboardRoutingModel } from '@aio-proxy/types';
import { upperFirst } from 'es-toolkit/string';

import type { RoutingSearch } from '../routing-search';

/** The bucket for a model models.dev cannot place: a cold catalog, or a record that names no
 * maker. Sorted last rather than alphabetically, so it never lands between two real labs. */
export const UNKNOWN_LAB = 'unknown';

const LAB_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  alibaba: 'Alibaba',
  meta: 'Meta',
  minimax: 'MiniMax',
  moonshotai: 'Moonshot AI',
  openai: 'OpenAI',
  perplexity: 'Perplexity',
  stepfun: 'StepFun',
  xai: 'xAI',
  zhipuai: 'Zhipu AI',
};

export const labDisplayName = (lab: string): string => {
  const override = LAB_NAME_OVERRIDES[lab];
  if (override !== undefined) return override;
  return lab.split('-').map(upperFirst).join(' ');
};

export const labOf = (model: DashboardRoutingModel): string => model.catalog?.lab ?? UNKNOWN_LAB;

const compareLab = (left: string, right: string): number => {
  if (left === right) return 0;
  if (left === UNKNOWN_LAB) return 1;
  if (right === UNKNOWN_LAB) return -1;
  return left.localeCompare(right);
};

// Release dates are compared as strings on purpose: models.dev mixes `YYYY-MM` and
// `YYYY-MM-DD`, lexicographic order is already sensible across both, and parsing into a Date
// would introduce a timezone shift. A missing date sinks to the end of its own lab.
const compareReleaseDate = (left: string | undefined, right: string | undefined): number => {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right.localeCompare(left);
};

/** lab ascending, then newest release first, then model id. Independent of Provider health, so a
 * row's position stays predictable between visits. */
export const sortRoutingModels = (models: readonly DashboardRoutingModel[]): readonly DashboardRoutingModel[] =>
  [...models].sort(
    (left, right) =>
      compareLab(labOf(left), labOf(right)) ||
      compareReleaseDate(left.catalog?.releaseDate, right.catalog?.releaseDate) ||
      left.modelId.localeCompare(right.modelId),
  );

export const filterRoutingModels = (
  models: readonly DashboardRoutingModel[],
  search: RoutingSearch,
): readonly DashboardRoutingModel[] =>
  search.lab === undefined ? models : models.filter((model) => labOf(model) === search.lab);

/** Every lab present, each once, unknown last — the same order the table groups in. */
export const labOptions = (models: readonly DashboardRoutingModel[]): readonly string[] =>
  [...new Set(models.map(labOf))].sort(compareLab);
