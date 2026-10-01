//! The Usage group's numbers: which metric is picked, how it compares with the previous window, and
//! how the breakdowns rank. Pure; the views only lay these out.

use super::activity::weekday_name;
use super::format::{civil_from_days, compact, parse_utc, usd};
use crate::summary::{BucketUnit, UsageRange, UsageSlice, UsageTotals};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Metric {
    #[default]
    Requests,
    Failed,
    Tokens,
    Cost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Neutral,
    Bad,
    Good,
}

impl Metric {
    pub const ALL: [Metric; 4] = [Metric::Requests, Metric::Failed, Metric::Tokens, Metric::Cost];

    pub fn label(self) -> &'static str {
        match self {
            Metric::Requests => "Requests",
            Metric::Failed => "Failed",
            Metric::Tokens => "Tokens",
            Metric::Cost => "Cost",
        }
    }

    pub fn empty_text(self) -> &'static str {
        match self {
            Metric::Requests => "No requests in this window",
            Metric::Failed => "No failures in this window",
            Metric::Tokens => "No tokens in this window",
            Metric::Cost => "No cost in this window",
        }
    }

    /// More failures or more spend is bad; more traffic is neither.
    fn rising_is_bad(self) -> bool {
        matches!(self, Metric::Failed | Metric::Cost)
    }
}

pub fn metric_total(t: &UsageTotals, metric: Metric) -> u128 {
    match metric {
        Metric::Requests => t.requests,
        Metric::Failed => t.failed_requests,
        Metric::Tokens => t.input_tokens + t.output_tokens,
        Metric::Cost => t.estimated_cost_nano_usd,
    }
}

pub fn slice_value(s: &UsageSlice, metric: Metric) -> u128 {
    match metric {
        Metric::Requests => s.requests,
        Metric::Failed => s.failed_requests,
        Metric::Tokens => s.total_tokens,
        Metric::Cost => s.estimated_cost_nano_usd,
    }
}

pub fn format_value(value: u128, metric: Metric) -> String {
    if metric == Metric::Cost { usd(value) } else { compact(value) }
}

pub fn card_value(t: &UsageTotals, metric: Metric) -> String {
    let value = format_value(metric_total(t, metric), metric);
    if metric != Metric::Cost {
        return value;
    }
    match t.pricing_coverage {
        None => "—".into(),
        Some(coverage) if coverage < 1.0 => format!("≈{value}"),
        Some(_) => value,
    }
}

pub fn delta(current: u128, previous: u128, metric: Metric) -> (String, Tone) {
    if previous == 0 {
        return (if current == 0 { "—" } else { "new" }.into(), Tone::Neutral);
    }
    let tone = match (metric.rising_is_bad(), current.cmp(&previous)) {
        (false, _) | (true, std::cmp::Ordering::Equal) => Tone::Neutral,
        (true, std::cmp::Ordering::Greater) => Tone::Bad,
        (true, std::cmp::Ordering::Less) => Tone::Good,
    };
    if metric == Metric::Failed {
        let text =
            if current >= previous { format!("+{}", current - previous) } else { format!("−{}", previous - current) };
        return (text, tone);
    }
    let change = (current as f64 - previous as f64) / previous as f64 * 100.0;
    let arrow = if change >= 0.0 { '↑' } else { '↓' };
    let percent = format!("{:.0}", change.abs());
    // A change that reads 0% is no change worth a color.
    let tone = if percent == "0" { Tone::Neutral } else { tone };
    (format!("{arrow} {percent}%"), tone)
}

/// The card's delta line. Unknown pricing shows `—` for Cost, so its delta cannot claim a change.
pub fn card_delta(current: &UsageTotals, previous: &UsageTotals, metric: Metric) -> (String, Tone) {
    if metric == Metric::Cost && current.pricing_coverage.is_none() {
        return ("—".into(), Tone::Neutral);
    }
    delta(metric_total(current, metric), metric_total(previous, metric), metric)
}

/// Sorted by the metric, zeros last. `share` is each item's part of `total`, the window's total
/// for the metric (0 when it is 0): the lists are partial (top-20 models, Providers with traffic
/// only), so summing the items would overstate every share.
pub fn ranked<T>(
    items: &[T],
    slice: impl Fn(&T) -> &UsageSlice,
    metric: Metric,
    total: u128,
    limit: Option<usize>,
) -> Vec<(&T, u128, f64)> {
    let mut rows: Vec<_> = items
        .iter()
        .map(|item| {
            let value = slice_value(slice(item), metric);
            let share = if total == 0 { 0.0 } else { (value as f64 / total as f64).min(1.0) };
            (item, value, share)
        })
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row.1));
    if let Some(limit) = limit {
        rows.truncate(limit);
    }
    rows
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// The axis and caption label of a bucket, from its UTC start. Hourly buckets are rolling (they
/// start at now − 24 h + i h), so they read `HH:MM`; `7d` days read as weekdays (`Tue`) and `30d`
/// days as `Mon D` (the server's day bucket starts at local midnight). Empty when the timestamp
/// does not parse.
pub fn bucket_label(start: &str, unit: BucketUnit, range: UsageRange, utc_offset: i64) -> String {
    let Some(unix) = parse_utc(start) else { return String::new() };
    let local = unix + utc_offset;
    let days = local.div_euclid(86_400);
    match (unit, range) {
        (BucketUnit::Hour, _) => {
            let secs = local.rem_euclid(86_400);
            format!("{:02}:{:02}", secs / 3_600, secs % 3_600 / 60)
        }
        (BucketUnit::Day, UsageRange::D7) => weekday_name(days).to_string(),
        (BucketUnit::Day, _) => {
            let (_, month, day) = civil_from_days(days);
            format!("{} {day}", MONTHS[(month - 1) as usize])
        }
    }
}

#[cfg(test)]
mod tests;
