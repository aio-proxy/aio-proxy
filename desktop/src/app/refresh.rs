//! Summary fetching: the refresh scheduler's orders become transport requests, and responses
//! come back through the scheduler's tag check.

use std::time::{Duration, Instant};

use gpui_kit::App;

use super::{AppModel, SummaryState, changed};
use crate::client::refresh::{FetchOrder, Finished, Trigger};
use crate::client::transport::{self, HttpError, Limits, LocalUrl, Method, Request, Response};
use crate::summary::{DegradedReason, FetchOutcome, UsageRange, classify};

const SUMMARY_PATH: &str = "/dashboard/api/desktop-summary";
/// The least time between two rediscoveries a vanished instance triggers.
const GONE_REDISCOVERY_GAP: Duration = Duration::from_secs(5);

/// Whether a failed fetch means the discovered instance is gone (nothing, or a stranger, listens),
/// so discovery must re-run before the panel claims it runs. The gap keeps a discovery that still
/// reports the address reachable from turning every poll into another rediscovery.
pub(crate) fn rediscovers_after(error: &HttpError, last: Option<Instant>, now: Instant) -> bool {
    matches!(error, HttpError::Connect(_) | HttpError::UntrustedListener)
        && last.is_none_or(|at| now.saturating_duration_since(at) >= GONE_REDISCOVERY_GAP)
}

pub(crate) fn summary_path(range: UsageRange, refresh_quota: bool) -> String {
    let mut path = format!("{SUMMARY_PATH}?range={}", range.query());
    if refresh_quota {
        path.push_str("&refresh=true");
    }
    path
}

pub fn panel_opened(cx: &mut App) {
    super::lifecycle::refresh_login_item(cx);
    let order = cx.global_mut::<AppModel>().scheduler.open(Instant::now());
    dispatch(cx, order);
    super::check_health(cx);
    super::rediscover(cx);
}

pub fn panel_closed(cx: &mut App) {
    let model = cx.global_mut::<AppModel>();
    model.scheduler.close();
    // Dropping the fetch task drops its `Pending`, which shuts the socket down.
    model.fetch_task = None;
    model.timer_task = None;
    model.action.clear_outcome();
    // Read once like the action outcome: a menu toggle's error survives until a panel showed it.
    model.login_item_error = None;
    changed(cx);
}

pub fn manual_refresh(cx: &mut App) {
    trigger(cx, Trigger::Manual);
}

pub fn set_usage_range(cx: &mut App, range: UsageRange) {
    let model = cx.global_mut::<AppModel>();
    model.usage_range = range;
    let order = model.scheduler.set_range(range, Instant::now());
    dispatch(cx, order);
    changed(cx);
}

pub(super) fn after_action(cx: &mut App) {
    trigger(cx, Trigger::ActionDone);
}

fn trigger(cx: &mut App, trigger: Trigger) {
    let order = cx.global_mut::<AppModel>().scheduler.trigger(trigger, Instant::now());
    dispatch(cx, order);
}

/// Called after every discovery: a new (address, pid) pair is a new instance.
pub(super) fn instance_maybe_changed(cx: &mut App) {
    let model = cx.global_mut::<AppModel>();
    let key = model.discovery.as_ref().map(|d| (d.instance.control_url.clone().unwrap_or_default(), d.instance.pid));
    if key != model.instance {
        model.instance = key;
        model.instance_epoch += 1;
        model.forget_usage();
        model.auth_retry_used = false;
        model.refetch_after_discovery = false;
        let order = model.scheduler.set_instance(model.instance_epoch, Instant::now());
        dispatch(cx, order);
    } else if std::mem::take(&mut model.refetch_after_discovery) {
        trigger(cx, Trigger::Rediscovered);
    }
}

fn dispatch(cx: &mut App, order: Option<FetchOrder>) {
    if let Some(order) = order {
        start_fetch(cx, order);
    }
    arm_timer(cx);
}

fn summary_request(model: &AppModel, order: FetchOrder) -> Result<Request, SummaryState> {
    let Some(discovery) = &model.discovery else {
        return Err(SummaryState::Waiting);
    };
    let Some(base) = discovery.instance.control_url.as_deref().filter(|_| discovery.instance.reachable) else {
        return Err(SummaryState::Unavailable("aio-proxy is not running.".into()));
    };
    let Some(token) = discovery.token.clone() else {
        // An older proxy never writes a token: nothing was rejected, so this is the degraded panel.
        return Err(SummaryState::Degraded(DegradedReason::NoToken));
    };
    let url = LocalUrl::parse(base, &summary_path(order.range, order.refresh_quota))
        .map_err(|error| SummaryState::Unavailable(error.to_string()))?;
    Ok(Request { method: Method::Get, url, bearer: Some(token) })
}

fn start_fetch(cx: &mut App, order: FetchOrder) {
    match summary_request(cx.global::<AppModel>(), order) {
        Ok(request) => {
            let pending = transport::spawn(request, Limits::default());
            let task = cx.spawn(async move |cx| {
                let result = pending.await;
                cx.update(|cx| finish(cx, order, result));
            });
            cx.global_mut::<AppModel>().fetch_task = Some(task);
            // The header's refresh button spins while the request is out.
            changed(cx);
        }
        Err(state) => {
            let model = cx.global_mut::<AppModel>();
            model.scheduler.finished(order.tag, Finished::Failed, Instant::now());
            show(model, state, order.range);
            changed(cx);
        }
    }
}

/// Keeps the last good summary on screen and reports the problem next to it, for `range`.
fn show(model: &mut AppModel, state: SummaryState, range: UsageRange) {
    match (&model.summary, state) {
        (SummaryState::Ready(_), SummaryState::Unavailable(error)) => model.summary_error = Some((range, error)),
        (_, state) => model.summary = state,
    }
}

fn finish(cx: &mut App, order: FetchOrder, result: Result<Response, HttpError>) {
    let outcome = result.map(|response| classify(response.status, &response.body));
    let finished = match &outcome {
        Ok(FetchOutcome::Summary(summary)) => Finished::Summary { any_loading: summary.any_quota_loading() },
        _ => Finished::Failed,
    };
    let model = cx.global_mut::<AppModel>();
    let (accepted, follow) = model.scheduler.finished(order.tag, finished, Instant::now());
    if !accepted {
        return;
    }
    let mut retry_discovery = false;
    match outcome {
        Ok(FetchOutcome::Summary(summary)) => {
            model.accept_summary(summary);
            model.auth_retry_used = false;
        }
        Ok(FetchOutcome::Degraded(reason)) => {
            model.summary = SummaryState::Degraded(reason);
            model.summary_error = None;
        }
        // One rediscovery picks up a replaced token; a second 401 is final. Never restart the proxy.
        Ok(FetchOutcome::Unauthorized) if !model.auth_retry_used => {
            model.auth_retry_used = true;
            model.refetch_after_discovery = true;
            retry_discovery = true;
        }
        Ok(FetchOutcome::Unauthorized) => {
            model.summary = SummaryState::AuthFailed;
            model.summary_error = None;
        }
        Ok(FetchOutcome::Failed(error)) => show(model, SummaryState::Unavailable(error), order.range),
        Err(error) => {
            let now = Instant::now();
            if rediscovers_after(&error, model.gone_rediscovered_at, now) {
                model.gone_rediscovered_at = Some(now);
                retry_discovery = true;
            }
            show(model, SummaryState::Unavailable(format!("desktop summary: {error}")), order.range);
        }
    }
    dispatch(cx, follow);
    changed(cx);
    if retry_discovery {
        super::rediscover(cx);
    }
}

fn arm_timer(cx: &mut App) {
    let next = cx.global::<AppModel>().scheduler.next_wake();
    let task = next.map(|at| {
        cx.spawn(async move |cx| {
            cx.background_executor().timer(at.saturating_duration_since(Instant::now())).await;
            cx.update(|cx| {
                let order = cx.global_mut::<AppModel>().scheduler.wake(Instant::now());
                dispatch(cx, order);
            });
        })
    });
    cx.global_mut::<AppModel>().timer_task = task;
}

#[cfg(test)]
mod tests;
