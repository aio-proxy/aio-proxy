import type { OAuthQuotaItem, OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';

/** An item the upstream reported a remaining amount for. The others have nothing to display. */
export type ApplicableQuotaItem = OAuthQuotaItem & { readonly remainingRatio: number };

/**
 * A window with no remaining amount is left out entirely rather than shown as "not applicable":
 * a row that only says it has nothing to say is noise between the windows that do.
 */
export const applicableQuotaItems = (snapshot: OAuthQuotaSnapshot | undefined): readonly ApplicableQuotaItem[] =>
  snapshot?.items.filter((item): item is ApplicableQuotaItem => item.remainingRatio !== undefined) ?? [];

/** The ring shows the window closest to running out. An item with no ratio can never be "tightest". */
export const tightestQuotaItem = (snapshot: OAuthQuotaSnapshot | undefined): OAuthQuotaItem | undefined =>
  snapshot?.items.reduce<OAuthQuotaItem | undefined>((tightest, item) => {
    if (item.remainingRatio === undefined) return tightest;
    if (tightest?.remainingRatio === undefined) return item;
    return item.remainingRatio < tightest.remainingRatio ? item : tightest;
  }, undefined);

/**
 * Rounds for display. A quota with anything left never reads as 0%: seeing "0%" next to a working
 * Provider is the one number a user would act on incorrectly.
 */
export const remainingPercent = (ratio: number): number => {
  const clamped = Math.min(Math.max(ratio, 0), 1);
  if (clamped === 0) return 0;
  return Math.max(1, Math.round(clamped * 100));
};
