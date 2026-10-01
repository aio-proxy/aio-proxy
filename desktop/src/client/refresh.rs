//! The panel's refresh policy as a clock-injected state machine. The GPUI glue owns the timer and the
//! in-flight request; this decides when to fetch and which responses still count.

use std::time::{Duration, Instant};

use crate::summary::UsageRange;

pub const REFRESH_INTERVAL: Duration = Duration::from_secs(15);
pub const LOADING_RETRY: Duration = Duration::from_secs(2);

/// Every response is tagged; one from a closed session, another instance or an older counter is discarded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tag {
    pub session: u64,
    pub instance: u64,
    pub counter: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FetchOrder {
    pub tag: Tag,
    /// `?refresh=true`: only for a manual refresh.
    pub refresh_quota: bool,
    /// The usage window this response is for.
    pub range: UsageRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// Subject to the 15 s floor.
    Tick,
    /// A user action finished its completion condition.
    ActionDone,
    /// Manual refresh: bypasses the floor and asks the server to refresh quota.
    Manual,
    /// Discovery re-ran after a 401 and may carry a replaced token.
    Rediscovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finished {
    Summary { any_loading: bool },
    Failed,
}

#[derive(Debug, Default, Clone, Copy)]
struct Dirty {
    bypass: bool,
    refresh_quota: bool,
}

#[derive(Debug, Default)]
pub struct Scheduler {
    session: Option<u64>,
    sessions: u64,
    instance: u64,
    counter: u64,
    /// The one request allowed in flight, and whether it is the loading retry.
    in_flight: Option<(Tag, bool)>,
    dirty: Option<Dirty>,
    last_start: Option<Instant>,
    retry_at: Option<Instant>,
    range: UsageRange,
}

impl Scheduler {
    pub fn is_open(&self) -> bool {
        self.session.is_some()
    }

    /// Panel opened: a new session that fetches at once.
    pub fn open(&mut self, now: Instant) -> Option<FetchOrder> {
        self.close();
        self.sessions += 1;
        self.session = Some(self.sessions);
        self.issue(now, false, false)
    }

    /// Panel closed: forget the in-flight request and every timer. The glue drops both tasks.
    pub fn close(&mut self) {
        self.session = None;
        self.in_flight = None;
        self.dirty = None;
        self.last_start = None;
        self.retry_at = None;
    }

    pub fn range(&self) -> UsageRange {
        self.range
    }

    /// The usage window changed: the in-flight request (for the old window) stops counting and an
    /// open panel fetches the new one at once, ignoring the 15 s floor. A closed panel only remembers.
    pub fn set_range(&mut self, range: UsageRange, now: Instant) -> Option<FetchOrder> {
        if range == self.range {
            return None;
        }
        self.range = range;
        self.session?;
        self.in_flight = None;
        self.dirty = None;
        self.retry_at = None;
        self.issue(now, false, false)
    }

    /// Discovery found a different instance: stale responses stop counting, and an open panel refetches.
    pub fn set_instance(&mut self, instance: u64, now: Instant) -> Option<FetchOrder> {
        if instance == self.instance {
            return None;
        }
        self.instance = instance;
        self.in_flight = None;
        self.dirty = None;
        self.retry_at = None;
        self.issue(now, false, false)
    }

    pub fn trigger(&mut self, trigger: Trigger, now: Instant) -> Option<FetchOrder> {
        self.session?;
        let bypass = trigger != Trigger::Tick;
        let refresh_quota = trigger == Trigger::Manual;
        if self.in_flight.is_some() {
            let dirty = self.dirty.get_or_insert_default();
            dirty.bypass |= bypass;
            dirty.refresh_quota |= refresh_quota;
            return None;
        }
        if !bypass && self.floor_blocks(now) {
            return None;
        }
        self.issue(now, refresh_quota, false)
    }

    /// A request finished. Returns whether its result may be shown, plus a follow-up fetch.
    pub fn finished(&mut self, tag: Tag, outcome: Finished, now: Instant) -> (bool, Option<FetchOrder>) {
        let Some((current, is_retry)) = self.in_flight else {
            return (false, None);
        };
        if current != tag || self.session != Some(tag.session) || self.instance != tag.instance {
            return (false, None);
        }
        self.in_flight = None;
        if outcome == (Finished::Summary { any_loading: true }) && !is_retry && self.retry_at.is_none() {
            self.retry_at = Some(now + LOADING_RETRY);
        }
        let follow = match self.dirty.take() {
            Some(dirty) if dirty.bypass || !self.floor_blocks(now) => self.issue(now, dirty.refresh_quota, false),
            _ => None,
        };
        (true, follow)
    }

    /// When the glue's single timer should fire next; `None` while closed or while a request runs.
    pub fn next_wake(&self) -> Option<Instant> {
        self.session?;
        if self.in_flight.is_some() {
            return None;
        }
        let tick = self.last_start.map(|start| start + REFRESH_INTERVAL);
        match (tick, self.retry_at) {
            (Some(tick), Some(retry)) => Some(tick.min(retry)),
            (tick, retry) => tick.or(retry),
        }
    }

    pub fn wake(&mut self, now: Instant) -> Option<FetchOrder> {
        self.session?;
        if self.in_flight.is_some() {
            return None;
        }
        if self.retry_at.is_some_and(|at| at <= now) {
            self.retry_at = None;
            return self.issue(now, false, true);
        }
        if self.floor_blocks(now) {
            return None;
        }
        self.issue(now, false, false)
    }

    fn floor_blocks(&self, now: Instant) -> bool {
        self.last_start.is_some_and(|start| now < start + REFRESH_INTERVAL)
    }

    fn issue(&mut self, now: Instant, refresh_quota: bool, is_retry: bool) -> Option<FetchOrder> {
        let session = self.session?;
        self.counter += 1;
        let tag = Tag { session, instance: self.instance, counter: self.counter };
        self.in_flight = Some((tag, is_retry));
        self.last_start = Some(now);
        if !is_retry {
            // The response re-arms the retry if quota is still loading.
            self.retry_at = None;
        }
        Some(FetchOrder { tag, refresh_quota, range: self.range })
    }
}

#[cfg(test)]
mod tests;
