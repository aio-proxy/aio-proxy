//! Pure display formatting: counts, money, reset times and local calendar days.

pub fn compact(n: u128) -> String {
    const UNITS: [(u128, &str); 4] = [(1_000_000_000_000, "T"), (1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")];
    for (scale, unit) in UNITS {
        if n >= scale {
            let tenths = n * 10 / scale;
            return if tenths >= 1_000 {
                format!("{}{unit}", tenths / 10)
            } else {
                format!("{}.{}{unit}", tenths / 10, tenths % 10)
            };
        }
    }
    n.to_string()
}

/// Nano-USD to dollars, two decimals; a non-zero amount below a cent reads `<$0.01`.
pub fn usd(nano: u128) -> String {
    let cents = nano / 10_000_000;
    if cents == 0 && nano > 0 {
        return "<$0.01".into();
    }
    format!("${}.{:02}", cents / 100, cents % 100)
}

/// The Cost card's amount: three significant digits, so `≈` and the amount fit the card (`$7.46`,
/// `$74.6`, `$746`, `$1.2K`). Floors, as [`usd`] and [`compact`] do.
pub fn usd_short(nano: u128) -> String {
    let cents = nano / 10_000_000;
    match cents {
        0 if nano > 0 => "<$0.01".into(),
        0..=999 => usd(nano),
        1_000..=9_999 => format!("${}.{}", cents / 100, cents % 100 / 10),
        10_000..=99_999 => format!("${}", cents / 100),
        _ => format!("${}", compact(cents / 100)),
    }
}

/// Floors (99.6% remaining is not 100%); the epsilon absorbs binary artifacts like 0.29 * 100 = 28.99….
pub fn percent(ratio: f64) -> String {
    format!("{:.0}%", (ratio.clamp(0.0, 1.0) * 100.0 + 1e-9).floor())
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (i64::from(month) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse of `days_from_civil`: (year, month, day).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// `YYYY-MM-DD` to a day number.
pub fn parse_date(text: &str) -> Option<i64> {
    let mut parts = text.splitn(3, '-');
    let year = parts.next()?.parse().ok()?;
    let month = parts.next()?.parse().ok().filter(|m| (1..=12).contains(m))?;
    let day = parts.next()?.parse().ok().filter(|d| (1..=31).contains(d))?;
    Some(days_from_civil(year, month, day))
}

/// RFC 3339 in UTC (`…Z` or `…+00:00`, as the server's `toISOString()` writes) to Unix seconds.
pub fn parse_utc(text: &str) -> Option<i64> {
    let (date, time) = text.split_once('T')?;
    let time = time.strip_suffix('Z').or_else(|| time.strip_suffix("+00:00"))?;
    let time = time.split('.').next()?;
    let mut hms = time.splitn(3, ':').map(|part| part.parse::<i64>().ok());
    let (h, m, s) = (hms.next()??, hms.next()??, hms.next()??);
    Some(parse_date(date)? * 86_400 + h * 3_600 + m * 60 + s)
}

/// `resetsAt` relative to now: "in 2h 5m", "in 40m", "now".
pub fn until(now: i64, at: i64) -> String {
    let minutes = (at - now).max(0) / 60;
    match (minutes / 1_440, minutes / 60 % 24, minutes % 60) {
        (0, 0, 0) => "now".into(),
        (0, 0, m) => format!("in {m}m"),
        (0, h, m) => format!("in {h}h {m}m"),
        (d, h, _) => format!("in {d}d {h}h"),
    }
}

/// The local UTC offset in seconds (glue for the pure functions above).
pub fn local_utc_offset(unix: i64) -> i64 {
    use chrono::{Local, Offset, TimeZone};
    Local.timestamp_opt(unix, 0).single().map_or(0, |time| i64::from(time.offset().fix().local_minus_utc()))
}

#[cfg(test)]
mod tests;
