//! Live metrics polling outlives the panel and follows the current preferences and instance.

use std::time::{Duration, Instant};

use gpui_kit::App;

use super::{AppModel, refresh::rediscovers_after};
use crate::client::health::HealthState;
use crate::client::transport::{self, HttpError, Limits, LocalUrl, Method, Request, Response};
use crate::tray::{LiveKey, rediscover_unreachable};

pub fn start(cx: &mut App) {
    cx.spawn(async move |cx| {
        loop {
            cx.update(tick);
            cx.background_executor().timer(Duration::from_secs(1)).await;
        }
    })
    .detach();
}

fn tick(cx: &mut App) {
    let model = cx.global_mut::<AppModel>();
    let now = Instant::now();
    let epoch = model.instance_epoch;
    if model.live.epoch() != epoch {
        model.live.set_epoch(epoch);
    }
    let key = LiveKey { metrics: model.prefs.tray_metrics.clone(), epoch };
    let health_up = model.health.state() == HealthState::Up;
    let endpoint = model.discovery.as_ref().and_then(|discovery| {
        let base = discovery.instance.control_url.as_deref().filter(|_| discovery.instance.reachable)?;
        Some((base, discovery.token.clone()?))
    });
    let eligible = health_up && endpoint.is_some();
    let request = if model.live_schedule.due(now, &key, eligible) {
        endpoint.map(|(base, token)| {
            LocalUrl::parse(base, "/dashboard/api/desktop-live").map(|url| Request {
                method: Method::Get,
                url,
                bearer: Some(token),
            })
        })
    } else {
        None
    };
    let retry_discovery = rediscover_unreachable(
        !key.metrics.is_empty(),
        health_up,
        model.discovery.as_ref().map(|discovery| discovery.instance.reachable),
        model.gone_rediscovered_at,
        now,
    );
    if retry_discovery {
        model.gone_rediscovered_at = Some(now);
    }
    match request {
        Some(Ok(request)) => {
            let pending = transport::spawn(request, Limits::default());
            cx.spawn(async move |cx| {
                let result = pending.await;
                cx.update(|cx| finish(cx, epoch, result));
            })
            .detach();
        }
        Some(Err(error)) => finish(cx, epoch, Err(error)),
        None => {}
    }
    if retry_discovery {
        super::rediscover(cx);
    }
    crate::tray::sync(cx);
}

fn finish(cx: &mut App, epoch: u64, result: Result<Response, HttpError>) {
    let model = cx.global_mut::<AppModel>();
    // Discovery can replace the instance between ticks, before LiveDisplay sees the new epoch.
    if epoch != model.instance_epoch {
        model.live_schedule.finished();
        return;
    }
    let mut retry_discovery = false;
    match result {
        Ok(response) if response.status == 200 => match crate::live::parse(&response.body) {
            Ok(live) => model.live.accept(epoch, live),
            Err(_) => model.live.fail(epoch),
        },
        Ok(response) if response.status == 401 => retry_discovery = model.live.unauthorized(epoch),
        Err(error) => {
            model.live.fail(epoch);
            let now = Instant::now();
            if rediscovers_after(&error, model.gone_rediscovered_at, now) {
                model.gone_rediscovered_at = Some(now);
                retry_discovery = true;
            }
        }
        Ok(_) => model.live.fail(epoch),
    }
    model.live_schedule.finished();
    if retry_discovery {
        super::rediscover(cx);
    }
    crate::tray::sync(cx);
}
