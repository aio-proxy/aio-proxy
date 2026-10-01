//! The Usage group's numbers: which metric is picked, how it compares with the previous window, and
//! how the breakdowns rank. Pure; the views only lay these out.

use super::format::{civil_from_days, compact, parse_utc, usd};
use crate::summary::{BucketUnit, UsageSlice, UsageTotals};

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
    (format!("{arrow} {:.0}%", change.abs()), tone)
}

/// Sorted by the metric, zeros last; `share` is each item's part of the metric's total (0 when the
/// total is 0).
pub fn ranked<T>(
    items: &[T],
    slice: impl Fn(&T) -> &UsageSlice,
    metric: Metric,
    limit: Option<usize>,
) -> Vec<(&T, u128, f64)> {
    let total: u128 = items.iter().map(|item| slice_value(slice(item), metric)).sum();
    let mut rows: Vec<_> = items
        .iter()
        .map(|item| {
            let value = slice_value(slice(item), metric);
            let share = if total == 0 { 0.0 } else { value as f64 / total as f64 };
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

/// `HH:00` for hourly buckets, `Mon D` for daily ones (the server's day bucket starts at local
/// midnight); empty when the timestamp does not parse.
pub fn bucket_label(start: &str, unit: BucketUnit, utc_offset: i64) -> String {
    let Some(unix) = parse_utc(start) else { return String::new() };
    let local = unix + utc_offset;
    match unit {
        BucketUnit::Hour => format!("{:02}:00", local.rem_euclid(86_400) / 3_600),
        BucketUnit::Day => {
            let (_, month, day) = civil_from_days(local.div_euclid(86_400));
            format!("{} {day}", MONTHS[(month - 1) as usize])
        }
    }
}

#[cfg(test)]
mod tests;
