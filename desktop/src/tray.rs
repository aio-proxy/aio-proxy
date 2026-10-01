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
pub const ICON_PX: u32 = 36;

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

/// Template-image pixels: a disc (running), a ring (down), a disc with a hole (attention). AppKit
/// tints template images for light and dark menu bars.
pub fn icon_rgba(state: TrayState) -> Vec<u8> {
    let centre = (ICON_PX as f32 - 1.0) / 2.0;
    let mut rgba = Vec::with_capacity((ICON_PX * ICON_PX * 4) as usize);
    for y in 0..ICON_PX {
        for x in 0..ICON_PX {
            let d = ((x as f32 - centre).powi(2) + (y as f32 - centre).powi(2)).sqrt();
            let on = match state {
                TrayState::Running => d <= 12.0,
                TrayState::Down => (9.0..=12.0).contains(&d),
                TrayState::Attention => (4.5..=12.0).contains(&d),
            };
            rgba.extend_from_slice(if on { &[0, 0, 0, 255] } else { &[0, 0, 0, 0] });
        }
    }
    rgba
}

fn icon(state: TrayState) -> Icon {
    Icon::from_rgba(icon_rgba(state), ICON_PX, ICON_PX).expect("icon buffer matches its size")
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
            MenuEntry::Check { command, label, checked } => {
                menu.append(&CheckMenuItem::with_id(command.id(), label, true, *checked, None))
            }
            MenuEntry::Separator => menu.append(&PredefinedMenuItem::separator()),
        };
    }
    menu
}

/// Re-derives the icon and the right-click menu from the model; cheap when nothing changed.
pub fn sync(cx: &mut App) {
    let Some(model) = cx.try_global::<AppModel>() else {
        return;
    };
    let state = tray_state(model.health.state(), model.needs_attention());
    let offered = model
        .discovery
        .as_ref()
        .map(|d| crate::connect::policy::offered_actions(d, model.persistent()))
        .unwrap_or_default();
    let entries = menu_entries(offered, model.action.is_busy(), model.persistent(), model.login_item);
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
