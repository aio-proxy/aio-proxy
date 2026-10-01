//! The Quota group's model: which Providers appear, each window's pace against an even burn, and
//! the attention order. Pure; the view only lays these out.

use super::format::{parse_utc, until};
use crate::summary::{Provider, Quota, QuotaWindow};

/// Below this remaining ratio a window fills amber and its Provider needs attention.
pub const LOW: f64 = 0.15;

#[derive(Debug, Clone, PartialEq)]
pub struct Pace {
    /// Where an even burn would be now: the pace tick, as a remaining ratio.
    pub expected: f64,
    pub behind: bool,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowView {
    pub label: String,
    pub remaining: Option<f64>,
    /// "resets in 2h 13m".
    pub left_text: Option<String>,
    pub pace: Option<Pace>,
    pub low: bool,
}

pub struct QuotaBlock<'a> {
    pub provider: &'a Provider,
    /// The service, so accounts of different plugins under one email stay apart.
    pub title: String,
    /// The account, or the Provider name when the plugin reports none; omitted when it repeats the title.
    pub subtitle: Option<String>,
    pub windows: Vec<WindowView>,
    /// 0 failed or diagnostic, 1 a window below 15%, 2 a window behind pace, 3 the rest.
    pub rank: u8,
    pub message: Option<String>,
    pub command: Option<String>,
    pub plan: Option<String>,
    pub sampled_at: Option<i64>,
    pub refresh_failed: bool,
    pub loading: bool,
}

pub fn duration_text(minutes: f64) -> String {
    let minutes = minutes.max(0.0).round() as i64;
    match (minutes / 1_440, minutes / 60 % 24, minutes % 60) {
        (0, 0, m) => format!("{m}m"),
        (0, h, m) => format!("{h}h {m}m"),
        (d, h, _) => format!("{d}d {h}h"),
    }
}

pub fn relative(now: i64, at: i64) -> String {
    let seconds = (now - at).max(0);
    match seconds {
        0..60 => "just now".into(),
        60..3_600 => format!("{} min ago", seconds / 60),
        3_600..86_400 => format!("{} h ago", seconds / 3_600),
        _ => format!("{} d ago", seconds / 86_400),
    }
}

/// The spec's pace math. `left` and `length` are minutes; `remaining` is 0..=1.
pub(crate) fn pace(remaining: f64, left: f64, length: f64) -> Pace {
    if length <= 0.0 {
        return Pace { expected: 0.0, behind: false, note: "0% in reserve · lasts until reset".into() };
    }
    let (remaining, left) = (remaining.clamp(0.0, 1.0), left.max(0.0));
    let elapsed = (1.0 - left / length).clamp(0.01, 1.0);
    let expected = 1.0 - elapsed;
    let reserve = remaining - expected;
    let burn = (1.0 - remaining) / (elapsed * length);
    let runs_out_in = if burn > 0.0 { remaining / burn } else { f64::INFINITY };
    let behind = reserve < 0.0 && runs_out_in < left;
    let note = if behind {
        format!("{:.0}% over pace · runs out in {}", (-reserve * 100.0).round(), duration_text(runs_out_in))
    } else {
        format!("{:.0}% in reserve · lasts until reset", (reserve.max(0.0) * 100.0).round())
    };
    Pace { expected, behind, note }
}

fn window_view(window: &QuotaWindow, now: i64) -> WindowView {
    let reset = window.resets_at.as_deref().and_then(parse_utc);
    let projection = match (window.remaining_ratio, reset, window.window_minutes) {
        (Some(remaining), Some(at), Some(length)) if length > 0 => {
            Some(pace(remaining.clamp(0.0, 1.0), ((at - now).max(0) as f64) / 60.0, f64::from(length)))
        }
        _ => None,
    };
    WindowView {
        label: window.label.text().to_string(),
        remaining: window.remaining_ratio.map(|r| r.clamp(0.0, 1.0)),
        left_text: reset.map(|at| format!("resets {}", until(now, at))),
        pace: projection,
        low: window.remaining_ratio.is_some_and(|r| r < LOW),
    }
}

/// Providers with a quota capability, in attention order (spec ranks), then by name (case-insensitive).
pub fn quota_blocks(providers: &[Provider], now: i64) -> Vec<QuotaBlock<'_>> {
    let mut blocks: Vec<_> = providers
        .iter()
        .filter(|p| matches!(p.quota, Quota::Loading | Quota::Failed | Quota::Ready { .. }))
        .map(|provider| {
            let (windows, plan, sampled_at, refresh_failed) = match &provider.quota {
                Quota::Ready { windows, plan, sampled_at, refresh_failed } => (
                    windows.iter().map(|w| window_view(w, now)).collect(),
                    plan.as_ref().map(|p| p.text().to_string()).filter(|p| !p.is_empty()),
                    parse_utc(sampled_at),
                    *refresh_failed,
                ),
                _ => (Vec::new(), None, None, false),
            };
            let failed = matches!(provider.quota, Quota::Failed);
            let message = provider
                .diagnostic
                .as_ref()
                .map(|d| d.summary.clone())
                .or_else(|| failed.then(|| "Quota unavailable".to_string()));
            let rank = if message.is_some() {
                0
            } else if windows.iter().any(|w: &WindowView| w.low) {
                1
            } else if windows.iter().any(|w| w.pace.as_ref().is_some_and(|p| p.behind)) {
                2
            } else {
                3
            };
            QuotaBlock {
                provider,
                title: provider.title(),
                subtitle: provider.subtitle(),
                windows,
                rank,
                message,
                command: provider.diagnostic.as_ref().and_then(|d| d.suggested_command.clone()),
                plan,
                sampled_at,
                refresh_failed,
                loading: matches!(provider.quota, Quota::Loading),
            }
        })
        .collect();
    blocks.sort_by(|a, b| {
        a.rank
            .cmp(&b.rank)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then_with(|| {
                a.subtitle.as_ref().map(|s| s.to_lowercase()).cmp(&b.subtitle.as_ref().map(|s| s.to_lowercase()))
            })
            .then_with(|| a.title.cmp(&b.title))
    });
    blocks
}

/// Where a plugin icon loads from, as the Dashboard's `PluginIcon` resolves it: a URL as is, a
/// Lobe Icons slug from the static PNG set for the appearance. Anything else draws no image.
// ponytail: `data:image/` icons get the letter: GPUI parses an image URI as `http::Uri`, which
// rejects `data:`. Decode them into an `Image` when a plugin ships one.
pub fn icon_url(icon: &str, dark: bool) -> Option<String> {
    if icon.starts_with("http://") || icon.starts_with("https://") {
        return Some(icon.to_string());
    }
    let slug = icon.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let theme = if dark { "dark" } else { "light" };
    slug.then(|| format!("https://fastly.jsdelivr.net/npm/@lobehub/icons-static-png@latest/{theme}/{icon}.png"))
}

impl QuotaBlock<'_> {
    /// The window with the least left, which the collapsed title shows.
    pub fn tightest(&self) -> Option<&WindowView> {
        self.windows
            .iter()
            .filter_map(|w| w.remaining.map(|r| (w, r)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(w, _)| w)
    }

    /// Failing or nearly exhausted blocks open on their own; the rest start collapsed.
    pub fn opens_by_default(&self) -> bool {
        self.rank <= 1
    }
}

/// Failing or nearly exhausted counts; merely over pace only sorts higher.
pub fn attention_count(blocks: &[QuotaBlock]) -> usize {
    blocks.iter().filter(|b| b.rank <= 1).count()
}

#[cfg(test)]
mod tests;
