//! Pure metric presentation and request state, independent of the tray's native UI.

use std::time::{Duration, Instant};

use super::TrayState;
#[cfg(any(target_os = "macos", test))]
use super::tray_state;
#[cfg(any(target_os = "macos", test))]
use crate::app::AppModel;
#[cfg(any(target_os = "macos", test))]
use crate::client::health::HealthState;

use crate::live::DesktopLive;
use crate::prefs::TrayMetric;

#[derive(Clone, PartialEq, Debug)]
pub struct Shown {
    pub(super) state: TrayState,
    pub(super) color: [u8; 3],
    pub(super) lines: Vec<MetricText>,
    pub(super) show_icon: bool,
    pub(super) dimmed: bool,
}

#[cfg(any(target_os = "macos", test))]
pub fn shown_for(model: &AppModel, color: [u8; 3]) -> Shown {
    let stopped = model.health.state() == HealthState::Down
        || model.discovery.as_ref().is_none_or(|discovery| !discovery.instance.reachable);
    let state = if stopped { TrayState::Down } else { tray_state(model.health.state(), model.needs_attention()) };
    let view = if model.live.epoch() == model.instance_epoch { model.live.view() } else { LiveView::Unavailable };
    let dimmed = stopped || matches!(view, LiveView::Stale(_));
    let lines = if stopped {
        Vec::new()
    } else {
        model
            .prefs
            .tray_metrics
            .iter()
            .map(|&metric| match view {
                LiveView::Fresh(live) | LiveView::Stale(live) => format_metric(metric, live),
                LiveView::Unavailable => {
                    let mut text = format_metric(
                        metric,
                        &crate::live::DesktopLive {
                            today_tokens: 0,
                            today_cost_nano_usd: 0,
                            in_flight: 0,
                            output_tokens_per_second: 0.0,
                        },
                    );
                    text.value = "—".into();
                    text
                }
            })
            .collect()
    };
    Shown { state, color, lines, show_icon: stopped || model.prefs.shows_icon(), dimmed }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct MetricText {
    pub label: &'static str,
    pub value: String,
    pub unit: &'static str,
}

pub fn format_metric(metric: TrayMetric, live: &DesktopLive) -> MetricText {
    let (label, value, unit) = match metric {
        TrayMetric::TodayTokens => ("TOK", tokens(live.today_tokens), "tok"),
        TrayMetric::TokensPerSecond => {
            let rate = live.output_tokens_per_second;
            let tenths = (rate * 10.0).round() / 10.0;
            let value = if tenths < 100.0 { format!("{tenths:.1}") } else { format!("{:.0}", rate.round()) };
            ("TPS", value, "tok/s")
        }
        TrayMetric::TodayCost => {
            let nano = live.today_cost_nano_usd;
            let cents = rounded(nano, 10_000_000);
            let value = if cents < 10_000 {
                format!("{}.{:02}", cents / 100, cents % 100)
            } else {
                rounded(nano, 1_000_000_000).to_string()
            };
            ("COST", format!("${value}"), "")
        }
        TrayMetric::InFlight => ("REQ", live.in_flight.to_string(), "req"),
    };
    MetricText { label, value, unit }
}

// Divide before rounding so large u128 counters never overflow or lose integer precision.
fn rounded(value: u128, divisor: u128) -> u128 {
    value / divisor + u128::from(value % divisor >= divisor / 2)
}

fn tokens(value: u128) -> String {
    const UNITS: [(u128, &str); 3] = [(1_000, "K"), (1_000_000, "M"), (1_000_000_000, "B")];
    for (index, &(scale, mut suffix)) in UNITS.iter().enumerate().rev() {
        if value >= scale {
            let mut decimals = match value / scale {
                0..=9 => 2,
                10..=99 => 1,
                _ => 0,
            };
            let mut factor = 10_u128.pow(decimals);
            let mut amount = rounded(value, scale / factor);
            // A rounding carry changes the display tier, even before the raw count reaches it.
            if amount == 1_000 {
                if decimals > 0 {
                    amount /= 10;
                    decimals -= 1;
                    factor /= 10;
                } else if let Some((_, next_suffix)) = UNITS.get(index + 1) {
                    amount = 100;
                    decimals = 2;
                    factor = 100;
                    suffix = next_suffix;
                }
            }
            return if decimals == 0 {
                format!("{amount}{suffix}")
            } else {
                format!("{}.{:0width$}{suffix}", amount / factor, amount % factor, width = decimals as usize)
            };
        }
    }
    value.to_string()
}

pub fn poll_interval(metrics: &[TrayMetric]) -> Option<Duration> {
    if metrics.is_empty() {
        None
    } else if metrics.iter().any(|metric| matches!(metric, TrayMetric::TokensPerSecond | TrayMetric::InFlight)) {
        Some(Duration::from_secs(1))
    } else {
        Some(Duration::from_secs(15))
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LiveKey {
    pub metrics: Vec<TrayMetric>,
    pub epoch: u64,
}

#[derive(Default)]
pub struct LiveSchedule {
    last: Option<(Instant, LiveKey)>,
    in_flight: bool,
}

impl LiveSchedule {
    /// Ineligible ticks clear the timer so recovery can poll immediately after any request finishes.
    pub fn due(&mut self, now: Instant, key: &LiveKey, eligible: bool) -> bool {
        if !eligible {
            self.last = None;
            return false;
        }
        let Some(interval) = poll_interval(&key.metrics) else {
            // Re-enabling the same selection later must fetch at once, not wait out the old interval.
            self.last = None;
            return false;
        };
        if self.in_flight {
            return false;
        }
        if let Some((last, previous_key)) = &self.last
            && previous_key == key
            && now.duration_since(*last) < interval
        {
            return false;
        }
        self.last = Some((now, key.clone()));
        self.in_flight = true;
        true
    }

    pub fn finished(&mut self) {
        self.in_flight = false;
    }
}

pub fn rediscover_unreachable(
    has_metrics: bool,
    health_up: bool,
    reachable: Option<bool>,
    last: Option<Instant>,
    now: Instant,
) -> bool {
    has_metrics
        && health_up
        && reachable == Some(false)
        && last.is_none_or(|last| now.duration_since(last) >= Duration::from_secs(5))
}

#[derive(Default)]
pub struct LiveDisplay {
    epoch: u64,
    last: Option<DesktopLive>,
    failures: u32,
    auth_retry_used: bool,
}

pub enum LiveView<'a> {
    Fresh(&'a DesktopLive),
    Stale(&'a DesktopLive),
    Unavailable,
}

impl LiveDisplay {
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn set_epoch(&mut self, epoch: u64) {
        if self.epoch != epoch {
            *self = Self { epoch, ..Self::default() };
        }
    }

    /// Late responses from another instance must not restore its data or change retry state.
    pub fn accept(&mut self, epoch: u64, live: DesktopLive) {
        if epoch == self.epoch {
            self.last = Some(live);
            self.failures = 0;
            self.auth_retry_used = false;
        }
    }

    pub fn fail(&mut self, epoch: u64) {
        if epoch == self.epoch {
            self.failures = self.failures.saturating_add(1);
        }
    }

    pub fn unauthorized(&mut self, epoch: u64) -> bool {
        if epoch != self.epoch {
            return false;
        }
        self.fail(epoch);
        let retry = !self.auth_retry_used;
        self.auth_retry_used = true;
        retry
    }

    pub fn view(&self) -> LiveView<'_> {
        match (&self.last, self.failures) {
            (Some(live), 0) => LiveView::Fresh(live),
            (Some(live), 1..=2) => LiveView::Stale(live),
            _ => LiveView::Unavailable,
        }
    }
}

#[cfg(test)]
mod tests;
