//! Watches the D-Bus name `org.kde.StatusNotifierWatcher`: whoever owns it shows tray icons.

use futures::channel::mpsc::UnboundedSender;
use zbus::blocking::Connection;
use zbus::blocking::fdo::DBusProxy;
use zbus::names::BusName;

use crate::app::AppEvent;
use crate::log;

const WATCHER: &str = "org.kde.StatusNotifierWatcher";

/// Reports the owner now and on every change. Any D-Bus failure reports no watcher, so the window
/// opens rather than the app running with nothing on screen.
pub fn watch_tray_host(events: UnboundedSender<AppEvent>) {
    std::thread::spawn(move || {
        if let Err(error) = watch(&events) {
            log::info(format!("tray host: D-Bus watch failed: {error}"));
        }
        let _ = events.unbounded_send(AppEvent::TrayHost(false));
    });
}

fn watch(events: &UnboundedSender<AppEvent>) -> zbus::Result<()> {
    let connection = Connection::session()?;
    let dbus = DBusProxy::new(&connection)?;
    // Subscribe before asking, so an owner change between the two is not lost.
    let changes = dbus.receive_name_owner_changed_with_args(&[(0, WATCHER)])?;
    let owned = dbus.name_has_owner(BusName::try_from(WATCHER)?)?;
    if events.unbounded_send(AppEvent::TrayHost(owned)).is_err() {
        return Ok(());
    }
    for change in changes {
        let owned = change.args()?.new_owner().is_some();
        if events.unbounded_send(AppEvent::TrayHost(owned)).is_err() {
            break;
        }
    }
    Ok(())
}
