#![cfg_attr(windows, windows_subsystem = "windows")]
//! The menu-bar app: GPUI application, single-instance lock, tray, `--version`.

use aio_proxy_desktop::app::{self, AppEvent, AppModel, changed};
use aio_proxy_desktop::install;
use aio_proxy_desktop::panel::{self, PanelWindow};
use aio_proxy_desktop::version::APP_VERSION;
use aio_proxy_desktop::{log, platform, theme, tray};
use futures::StreamExt;
use futures::channel::mpsc;
use gpui_kit::App;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{APP_VERSION}");
        return;
    }
    let Some(home) = std::env::home_dir() else {
        eprintln!("aio-proxy-desktop: cannot find the home directory");
        std::process::exit(1);
    };
    let paths = platform::paths(&home);
    log::init(&paths.logs);
    // Held until the process exits; the OS drops the lock then.
    let _lock = match install::acquire_instance_lock(&paths.lock) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            log::info("another copy is already running; exiting");
            return;
        }
        Err(error) => {
            log::info(format!("cannot take the instance lock: {error}"));
            std::process::exit(1);
        }
    };
    let bundle =
        std::env::current_exe().ok().and_then(|exe| exe.canonicalize().ok()).and_then(|exe| install::bundle_of(&exe));
    log::info(format!("aio-proxy-desktop {APP_VERSION} starting from {bundle:?}"));

    gpui_kit::application().with_assets(gpui_kit::assets::Assets).run(move |cx| {
        gpui_kit::init(cx);
        theme::apply(cx.window_appearance(), cx);
        cx.set_http_client(std::sync::Arc::new(reqwest_client::ReqwestClient::new()));
        let (events, mut inbox) = mpsc::unbounded::<AppEvent>();
        platform::on_launch(cx, events.clone());

        cx.set_global(AppModel::new(paths, bundle));
        cx.set_global(PanelWindow::default());
        tray::install(cx, events.clone());
        platform::updater::start(events.clone());
        app::start(cx);
        app::start_health_timer(cx);
        cx.spawn(async move |cx| {
            while let Some(event) = inbox.next().await {
                cx.update(|cx| handle(cx, event, &events));
            }
        })
        .detach();
    });
}

fn handle(cx: &mut App, event: AppEvent, events: &mpsc::UnboundedSender<AppEvent>) {
    match event {
        AppEvent::TogglePanel => panel::toggle(cx),
        AppEvent::ClosePanel => panel::close_open(cx),
        AppEvent::Menu(command) => tray::run(cx, command),
        AppEvent::Wake => app::check_health(cx),
        AppEvent::UpdateAvailable(version) => {
            cx.global_mut::<AppModel>().update_pending = Some(version);
            changed(cx);
        }
        AppEvent::UpdateAttended => {
            cx.global_mut::<AppModel>().update_pending = None;
            changed(cx);
        }
        AppEvent::TrayHost(owned) => {
            // A watcher with no host registered yet (KDE login, a just-enabled GNOME extension) still
            // refuses the icon, so the mode follows the icon, not the watcher.
            let shown = owned && {
                tray::install(cx, events.clone());
                cx.has_global::<tray::Tray>()
            };
            panel::tray_host_changed(cx, shown);
        }
    }
}
