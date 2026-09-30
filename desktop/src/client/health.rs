//! `GET /health` bookkeeping: two consecutive failures mark the proxy down. Transitions trigger
//! rediscovery; nothing here ever mutates the service.

use std::time::Duration;

use serde::Deserialize;

pub const HEALTH_INTERVAL: Duration = Duration::from_secs(60);
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HealthState {
    #[default]
    Unknown,
    Up,
    Down,
}

#[derive(Debug, Default)]
pub struct HealthTracker {
    state: HealthState,
    failures: u32,
}

impl HealthTracker {
    pub fn state(&self) -> HealthState {
        self.state
    }

    /// Records one probe; returns the new state only when it changed.
    pub fn record(&mut self, ok: bool) -> Option<HealthState> {
        let next = if ok {
            self.failures = 0;
            HealthState::Up
        } else {
            self.failures += 1;
            if self.failures < 2 {
                return None;
            }
            HealthState::Down
        };
        (next != self.state).then(|| {
            self.state = next;
            next
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthReport {
    pub version: Option<String>,
}

/// Only aio-proxy's own `status: "ok"` marker counts, so another service on the port reads as down.
pub fn parse_health(status: u16, body: &[u8]) -> Option<HealthReport> {
    #[derive(Deserialize)]
    struct Body {
        status: Option<String>,
        version: Option<String>,
    }
    if !(200..300).contains(&status) {
        return None;
    }
    let body: Body = serde_json::from_slice(body).ok()?;
    (body.status.as_deref() == Some("ok")).then_some(HealthReport { version: body.version })
}

#[cfg(test)]
mod tests;
