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

/** Where a perfectly even burn would have left the window by now, and whether the real one is worse. */
export type QuotaPace = {
  /** Remaining percent a steady burn would show, as a track position from 0 to 100. */
  readonly expectedPercent: number;
  /** The window is being spent faster than evenly, so it runs dry before it resets. */
  readonly overspent: boolean;
};

/**
 * How far off the even burn a window has to be before the marker is worth drawing. Inside this band
 * the tick would sit on top of the fill edge and say nothing the bar does not already show.
 */
const ON_TRACK_PERCENT = 2;

/**
 * A steady-burn reference point for one window, or `undefined` when there is nothing worth marking.
 *
 * Both ends of the window have to be known: `resetsAt` alone says when it ends, and only
 * `windowMinutes` says when it started. A reset already in the past, or one further out than a whole
 * window, means the reading is stale or the clocks disagree — either way the elapsed fraction would
 * be fiction, and a confidently-placed wrong marker is worse than no marker.
 */
export const quotaPace = (item: ApplicableQuotaItem, now: number = Date.now()): QuotaPace | undefined => {
  const { resetsAt, windowMinutes } = item;
  if (resetsAt === undefined || windowMinutes === undefined || windowMinutes <= 0) return undefined;
  const durationMs = windowMinutes * 60_000;
  const remainingMs = resetsAt - now;
  if (remainingMs <= 0 || remainingMs > durationMs) return undefined;
  const expectedPercent = (remainingMs / durationMs) * 100;
  const margin = item.remainingRatio * 100 - expectedPercent;
  if (Math.abs(margin) <= ON_TRACK_PERCENT) return undefined;
  return { expectedPercent, overspent: margin < 0 };
};
