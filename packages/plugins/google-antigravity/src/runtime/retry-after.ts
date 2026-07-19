const IMF_DATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;
const RFC850_DATE_PATTERN =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;
const ASCTIME_DATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|[0-9]{2}) [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const LONG_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function retryAfterMilliseconds(value: string | null | undefined, now = Date.now()): number {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return Number.POSITIVE_INFINITY;
  if (/^[0-9]+$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isFinite(seconds) ? seconds * 1_000 : Number.POSITIVE_INFINITY;
  }
  const timestamp = parseHttpDate(normalized, now);
  return timestamp === undefined ? Number.POSITIVE_INFINITY : Math.max(0, timestamp - now);
}

function parseHttpDate(value: string, now: number): number | undefined {
  const rfc850 = parseRfc850Date(value, now);
  if (rfc850 !== undefined) return rfc850;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  if (IMF_DATE_PATTERN.test(value) && date.toUTCString() === value) return timestamp;
  if (ASCTIME_DATE_PATTERN.test(value) && formatAsctime(date) === value) return timestamp;
  return undefined;
}

function parseRfc850Date(value: string, now: number): number | undefined {
  const match = RFC850_DATE_PATTERN.exec(value);
  if (match === null) return undefined;
  const [, , dayText, monthText, yearText, hourText, minuteText, secondText] = match;
  const month = MONTHS.indexOf(monthText as (typeof MONTHS)[number]);
  const currentYear = new Date(now).getUTCFullYear();
  let year = Math.floor(currentYear / 100) * 100 + Number(yearText);
  let timestamp = Date.UTC(year, month, Number(dayText), Number(hourText), Number(minuteText), Number(secondText));
  if (timestamp < shiftedUtcYear(now, -50)) {
    year += 100;
    timestamp = Date.UTC(year, month, Number(dayText), Number(hourText), Number(minuteText), Number(secondText));
  }
  if (timestamp > shiftedUtcYear(now, 50)) {
    year -= 100;
    timestamp = Date.UTC(year, month, Number(dayText), Number(hourText), Number(minuteText), Number(secondText));
  }
  return formatRfc850(new Date(timestamp)) === value ? timestamp : undefined;
}

function shiftedUtcYear(timestamp: number, difference: number): number {
  const date = new Date(timestamp);
  date.setUTCFullYear(date.getUTCFullYear() + difference);
  return date.getTime();
}

function formatRfc850(date: Date): string {
  const [, day, month, year, time] = imfParts(date);
  return `${LONG_WEEKDAYS[date.getUTCDay()]}, ${day}-${month}-${year.slice(-2)} ${time} GMT`;
}

function formatAsctime(date: Date): string {
  const [weekday, , month, year, time] = imfParts(date);
  return `${weekday} ${month} ${String(date.getUTCDate()).padStart(2, " ")} ${time} ${year}`;
}

function imfParts(date: Date): [string, string, string, string, string] {
  return date.toUTCString().replace(",", "").split(" ") as [string, string, string, string, string];
}
