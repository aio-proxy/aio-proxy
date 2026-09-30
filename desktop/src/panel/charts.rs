//! The 7-day trend (GPUI Kit's bar chart) and the 365-cell activity heatmap (a plain grid).

use gpui_kit::component::chart::BarChart;
use gpui_kit::component::*;
use gpui_kit::*;

use super::format::{local_utc_offset, month_day, parse_date, parse_utc};
use crate::summary::{ActivityDay, TrendBucket};

pub const HEATMAP_DAYS: usize = 365;

/// Levels 0..=4 for the last 365 local days, oldest first; the last cell is `today`.
pub fn heatmap_levels(activity: &[ActivityDay], today: i64) -> Vec<u8> {
    let mut tokens = vec![0_u128; HEATMAP_DAYS];
    for day in activity {
        let Some(date) = parse_date(&day.date) else { continue };
        let age = today - date;
        if (0..HEATMAP_DAYS as i64).contains(&age) {
            tokens[HEATMAP_DAYS - 1 - age as usize] = day.total_tokens;
        }
    }
    let max = tokens.iter().copied().max().unwrap_or(0);
    tokens.iter().map(|&t| if t == 0 || max == 0 { 0 } else { (1 + t * 3 / max).min(4) as u8 }).collect()
}

#[derive(Clone)]
pub struct TrendPoint {
    pub label: SharedString,
    pub requests: f64,
}

pub fn trend_points(buckets: &[TrendBucket], utc_offset: i64) -> Vec<TrendPoint> {
    buckets
        .iter()
        .filter_map(|b| {
            let start = parse_utc(&b.start)?;
            Some(TrendPoint { label: month_day(start, utc_offset).into(), requests: b.requests as f64 })
        })
        .collect()
}

pub fn trend(buckets: &[TrendBucket], now: i64, cx: &App) -> impl IntoElement {
    let accent = cx.theme().chart_1;
    div().h(px(96.)).child(
        BarChart::new(trend_points(buckets, local_utc_offset(now)))
            .band(|p: &TrendPoint| p.label.clone())
            .value(|p: &TrendPoint| p.requests)
            .fill(move |_, _, _, _| accent)
            .id("trend-7d"),
    )
}

pub fn heatmap(activity: &[ActivityDay], now: i64, cx: &App) -> impl IntoElement {
    let accent = cx.theme().chart_1;
    let muted = cx.theme().muted;
    let today = (now + local_utc_offset(now)).div_euclid(86_400);
    h_flex().flex_wrap().gap(px(1.)).children(heatmap_levels(activity, today).into_iter().map(move |level| {
        let color = if level == 0 { muted } else { accent.opacity(f32::from(level) / 4.0) };
        div().size(px(7.)).rounded(px(1.)).bg(color)
    }))
}

#[cfg(test)]
mod tests;
