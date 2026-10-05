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
    /// The latest probe issued; an older one's answer is stale (see [`HealthTracker::finish`]).
    issued: u64,
}

impl HealthTracker {
    pub fn state(&self) -> HealthState {
        self.state
    }

    /// Starts a probe and returns its number. Panel open, wake, the timer and a finished action can
    /// each start one, so several may be in flight at once.
    pub fn begin(&mut self) -> u64 {
        self.issued += 1;
        self.issued
    }

    /// Records probe `probe`'s answer if it is still the latest. An older probe may have reached the
    /// instance a restart replaced, and its late failure must not mark the new one down.
    pub fn finish(&mut self, probe: u64, ok: bool) -> Option<HealthState> {
        if probe != self.issued {
            return None;
        }
        self.record(ok)
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

    /// A completed Stop already proved the proxy unreachable; no need to wait for two probes.
    pub fn mark_down(&mut self) {
        // A probe already in flight predates the Stop: its success must not bring the proxy back.
        self.issued += 1;
        self.failures = self.failures.max(2);
        self.state = HealthState::Down;
    }

    /// An action's closing discovery already proved the proxy answering `/health`. Marking it up here
    /// keeps the next probe from reporting a transition, whose rediscovery would repeat that discovery.
    pub fn mark_up(&mut self) {
        // As with a Stop, a probe already in flight predates the action.
        self.issued += 1;
        self.failures = 0;
        self.state = HealthState::Up;
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
