//! The health check: `GET /health` every 60 s, on panel open and on wake. It only updates the icon
//! and triggers rediscovery on a transition; it never mutates the service.

use gpui_kit::App;

use super::{AppModel, changed};
use crate::client::health::{HEALTH_INTERVAL, HEALTH_TIMEOUT, parse_health};
use crate::client::transport::{self, Limits, LocalUrl, Method, Request};

pub fn start_timer(cx: &mut App) {
    cx.spawn(async move |cx| {
        loop {
            cx.update(check_now);
            cx.background_executor().timer(HEALTH_INTERVAL).await;
        }
    })
    .detach();
}

pub fn check_now(cx: &mut App) {
    let Some(discovery) = cx.global::<AppModel>().discovery.as_ref() else {
        // Nothing to probe until the first discovery lands; it re-runs the check itself.
        return;
    };
    let url = discovery.instance.control_url.as_deref().and_then(|base| LocalUrl::parse(base, "/health").ok());
    let probe = cx.global_mut::<AppModel>().health.begin();
    let Some(url) = url else {
        record(cx, probe, false);
        return;
    };
    let limits = Limits { total: HEALTH_TIMEOUT, ..Limits::default() };
    let pending = transport::spawn(Request { method: Method::Get, url, bearer: None }, limits);
    cx.spawn(async move |cx| {
        let ok = pending.await.ok().and_then(|r| parse_health(r.status, &r.body)).is_some();
        cx.update(|cx| record(cx, probe, ok));
    })
    .detach();
}

/// Only the latest probe counts: one superseded by a newer probe (or by a Stop) is dropped.
fn record(cx: &mut App, probe: u64, ok: bool) {
    let transition = cx.global_mut::<AppModel>().health.finish(probe, ok);
    if transition.is_some() {
        changed(cx);
        super::rediscover(cx);
    }
}
