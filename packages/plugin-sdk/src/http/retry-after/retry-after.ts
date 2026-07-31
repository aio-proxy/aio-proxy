import { tz } from '@date-fns/tz';
import { format, isValid, parse } from 'date-fns';

// HTTP-date formats accepted by Retry-After (RFC 9110 §5.6.7 / §5.1). All three
// are anchored to GMT, so parsing and the round-trip check run in UTC. RFC 850's
// two-digit year uses date-fns' built-in ±50-year window around `now`.
const HTTP_DATE_FORMATS = [
  "EEE, dd MMM yyyy HH:mm:ss 'GMT'", // IMF-fixdate
  "EEEE, dd-MMM-yy HH:mm:ss 'GMT'", // RFC 850
  'EEE MMM d HH:mm:ss yyyy', // asctime
] as const;

const UTC = tz('GMT');

export function retryAfterMilliseconds(value: string | null | undefined, now = Date.now()): number {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === '') return Number.POSITIVE_INFINITY;
  if (/^[0-9]+$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isFinite(seconds) ? seconds * 1_000 : Number.POSITIVE_INFINITY;
  }
  const timestamp = parseHttpDate(normalized, now);
  return timestamp === undefined ? Number.POSITIVE_INFINITY : Math.max(0, timestamp - now);
}

// Parses an HTTP-date, or undefined when malformed. Re-formatting with the same
// pattern and comparing to the input rejects overflowed fields (day 32) and
// mismatched weekdays that date-fns would otherwise tolerate. asctime pads a
// single-digit day to width two with a space, which the `d` token does not
// reproduce, so runs of spaces are collapsed before the comparison.
function parseHttpDate(value: string, now: number): number | undefined {
  const reference = new Date(now);
  const collapsed = value.replace(/ +/g, ' ');
  for (const pattern of HTTP_DATE_FORMATS) {
    const date = parse(collapsed, pattern, reference, { in: UTC });
    if (isValid(date) && format(date, pattern, { in: UTC }) === collapsed) return date.getTime();
  }
  return undefined;
}
