//! The menu-bar app: GPUI application, single-instance lock, tray, wake notification, `--version`.

use std::path::PathBuf;
use std::ptr::NonNull;

use aio_proxy_desktop::app::{self, AppEvent, AppModel};
use aio_proxy_desktop::install::{self, Paths};
use aio_proxy_desktop::panel::{self, PanelWindow};
use aio_proxy_desktop::version::APP_VERSION;
use aio_proxy_desktop::{log, tray};
use block2::RcBlock;
use futures::StreamExt;
use futures::channel::mpsc::{self, UnboundedSender};
use gpui_kit::App;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSWorkspace, NSWorkspaceDidWakeNotification};
use objc2_foundation::{NSNotification, NSOperationQueue};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{APP_VERSION}");
        return;
    }
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        eprintln!("aio-proxy-desktop: HOME is not set");
        std::process::exit(1);
    };
    let paths = Paths::for_home(&home);
    log::init(&paths.logs);
    // Held until the process exits; the kernel drops the flock then.
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

    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        // GPUI forces the Regular policy in applicationDidFinishLaunching; LSUIElement covers launch.
        let mtm = MainThreadMarker::new().expect("GPUI runs this callback on the main thread");
        NSApplication::sharedApplication(mtm).setActivationPolicy(NSApplicationActivationPolicy::Accessory);

        let (events, mut inbox) = mpsc::unbounded::<AppEvent>();
        cx.set_global(AppModel::new(paths, bundle));
        cx.set_global(PanelWindow::default());
        cx.set_global(tray::build(events.clone()).expect("create the menu-bar icon"));
        observe_wake(events);
        app::start(cx);
        app::start_health_timer(cx);
        cx.spawn(async move |cx| {
            while let Some(event) = inbox.next().await {
                cx.update(|cx| handle(cx, event));
            }
        })
        .detach();
    });
}

fn handle(cx: &mut App, event: AppEvent) {
    match event {
        AppEvent::TogglePanel => panel::toggle(cx),
        AppEvent::OpenDashboard => app::open_dashboard(cx),
        // Quitting leaves the proxy running: launchd owns it.
        AppEvent::Quit => cx.quit(),
        AppEvent::Wake => app::check_health(cx),
    }
}

/// `NSWorkspaceDidWakeNotification` on the main queue, for the life of the app.
fn observe_wake(events: UnboundedSender<AppEvent>) {
    let block = RcBlock::new(move |_: NonNull<NSNotification>| {
        let _ = events.unbounded_send(AppEvent::Wake);
    });
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: AppKit's static notification name; the main queue runs the block on the main thread.
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidWakeNotification),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    };
    std::mem::forget(observer);
}
