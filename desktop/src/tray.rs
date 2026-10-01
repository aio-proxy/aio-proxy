//! The menu-bar icon: left click toggles the panel, right click opens a native menu, and the icon
//! shows one of three states.

use futures::channel::mpsc::UnboundedSender;
use gpui_kit::{App, Global};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::app::{AppEvent, AppModel};
use crate::client::health::HealthState;

mod menu;

pub use menu::{MenuCommand, MenuEntry, menu_entries};

/// 18 pt tall at 2x.
pub const ICON_WIDTH: u32 = 58;
pub const ICON_HEIGHT: u32 = 36;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    Running,
    Down,
    /// Running, but something wants the user: an alert, a failed action, or a pending update.
    Attention,
}

pub fn tray_state(health: HealthState, attention: bool) -> TrayState {
    match (health, attention) {
        (HealthState::Up, true) => TrayState::Attention,
        (HealthState::Up, false) => TrayState::Running,
        _ => TrayState::Down,
    }
}

/// The AIO mark from `packages/brand`, 10 pt tall in a 58 x 36 canvas (18 pt at 2x) with room at the right
/// for the attention dot. Regenerate it from the brand path if the mark changes.
const MARK_PNG: &[u8] = include_bytes!("../assets/tray-mark.png");

/// Template-image pixels: the mark (running), the mark dimmed (down), the mark with a dot at its top
/// right (attention). AppKit tints template images for light and dark menu bars.
pub fn icon_rgba(state: TrayState) -> Vec<u8> {
    let mark = image::load_from_memory_with_format(MARK_PNG, image::ImageFormat::Png)
        .expect("the bundled tray mark decodes")
        .to_rgba8();
    let (dot_x, dot_y, dot_r) = (53.5_f32, 9.5_f32, 3.5_f32);
    let mut rgba = Vec::with_capacity((ICON_WIDTH * ICON_HEIGHT * 4) as usize);
    for (x, y, pixel) in mark.enumerate_pixels() {
        let alpha = f32::from(pixel[3]) / 255.0;
        let alpha = match state {
            TrayState::Running => alpha,
            // Like a disabled menu-bar item.
            TrayState::Down => alpha * 0.4,
            TrayState::Attention => {
                let d = ((x as f32 - dot_x).powi(2) + (y as f32 - dot_y).powi(2)).sqrt();
                alpha.max((dot_r + 0.5 - d).clamp(0.0, 1.0))
            }
        };
        rgba.extend_from_slice(&[0, 0, 0, (alpha * 255.0).round() as u8]);
    }
    rgba
}

fn icon(state: TrayState) -> Icon {
    Icon::from_rgba(icon_rgba(state), ICON_WIDTH, ICON_HEIGHT).expect("icon buffer matches its size")
}

pub struct Tray {
    pub icon: TrayIcon,
    shown: Option<TrayState>,
    entries: Vec<MenuEntry>,
}

impl Global for Tray {}

/// The context menu belongs to this app, so opening it never deactivates the panel: a right press
/// closes the panel itself before the menu shows.
pub fn click_event(button: MouseButton, state: MouseButtonState) -> Option<AppEvent> {
    match (button, state) {
        (MouseButton::Left, MouseButtonState::Up) => Some(AppEvent::TogglePanel),
        (MouseButton::Right, MouseButtonState::Down) => Some(AppEvent::ClosePanel),
        _ => None,
    }
}

/// Must run on the main thread inside the GPUI `run` callback.
pub fn build(events: UnboundedSender<AppEvent>) -> Result<Tray, String> {
    let icon = TrayIconBuilder::new()
        .with_icon(icon(TrayState::Down))
        .with_icon_as_template(true)
        .with_tooltip("AIO Proxy")
        .with_menu_on_left_click(false)
        .build()
        .map_err(|error| error.to_string())?;
    let clicks = events.clone();
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if let TrayIconEvent::Click { button, button_state, .. } = event
            && let Some(message) = click_event(button, button_state)
        {
            let _ = clicks.unbounded_send(message);
        }
    }));
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        if let Some(command) = MenuCommand::from_id(event.id.0.as_str()) {
            let _ = events.unbounded_send(AppEvent::Menu(command));
        }
    }));
    Ok(Tray { icon, shown: Some(TrayState::Down), entries: Vec::new() })
}

fn native_menu(entries: &[MenuEntry]) -> Menu {
    let menu = Menu::new();
    for entry in entries {
        let _ = match entry {
            MenuEntry::Item { command, label, enabled } => {
                menu.append(&MenuItem::with_id(command.id(), label, *enabled, None))
            }
            MenuEntry::Check { command, label, checked, enabled } => {
                menu.append(&CheckMenuItem::with_id(command.id(), label, *enabled, *checked, None))
            }
            MenuEntry::Separator => menu.append(&PredefinedMenuItem::separator()),
        };
    }
    menu
}

/// Forces the next `sync` to rebuild the menu, discarding any state muda changed natively.
pub fn invalidate_menu(cx: &mut App) {
    if cx.try_global::<Tray>().is_some() {
        cx.global_mut::<Tray>().entries.clear();
    }
}

/// The right-click menu for the model's state; the panel's `⋯` menu shows the same.
pub fn entries(model: &AppModel) -> Vec<MenuEntry> {
    let offered = model
        .discovery
        .as_ref()
        .map(|d| crate::connect::policy::offered_actions(d, model.persistent()))
        .unwrap_or_default();
    let dashboard = !crate::panel::is_down(model);
    menu_entries(offered, dashboard, model.action.is_busy(), model.persistent(), model.login_item)
}

/// Runs a menu command, from the right-click menu or the panel's `⋯` menu.
pub fn run(cx: &mut App, command: MenuCommand) {
    match command {
        MenuCommand::OpenDashboard => crate::app::open_dashboard(cx),
        MenuCommand::Run(action) => crate::app::run_user_action(cx, action),
        MenuCommand::OpenLogs => crate::app::open_logs(cx),
        MenuCommand::ToggleLogin => crate::app::toggle_login_item(cx),
        MenuCommand::CheckForUpdates => crate::updater::check_now(),
        // Quitting leaves the proxy running: launchd owns it.
        MenuCommand::Quit => cx.quit(),
    }
}

/// Re-derives the icon and the right-click menu from the model; cheap when nothing changed.
pub fn sync(cx: &mut App) {
    let Some(model) = cx.try_global::<AppModel>() else {
        return;
    };
    let state = tray_state(model.health.state(), model.needs_attention());
    let entries = entries(model);
    let Some(tray) = cx.try_global::<Tray>() else {
        return;
    };
    if tray.shown != Some(state) {
        let _ = tray.icon.set_icon_with_as_template(Some(icon(state)), true);
        cx.global_mut::<Tray>().shown = Some(state);
    }
    if cx.global::<Tray>().entries != entries {
        // tray-icon attaches the menu only while presenting it, so swapping it at any time is safe.
        let tray = cx.global_mut::<Tray>();
        tray.icon.set_menu(Some(Box::new(native_menu(&entries))));
        tray.entries = entries;
    }
}

#[cfg(test)]
mod tests;
