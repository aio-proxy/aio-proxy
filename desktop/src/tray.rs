//! The menu-bar icon: left click toggles the panel, right click opens a native menu, and the icon
//! shows one of three states.

use futures::channel::mpsc::UnboundedSender;
use gpui_kit::{App, Global};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::app::{AppEvent, AppModel};
use crate::client::health::HealthState;

mod menu;
mod mode;

pub use menu::{CliOffer, MenuCommand, MenuEntry, menu_entries};
pub use mode::{CloseAction, TrayMode, close_action, next_mode};

/// macOS: 18 pt tall at 2x. Elsewhere the icon is square, as the status-notifier hosts and the
/// Windows notification area expect.
#[cfg(target_os = "macos")]
pub const ICON_WIDTH: u32 = 58;
#[cfg(target_os = "macos")]
pub const ICON_HEIGHT: u32 = 36;
#[cfg(not(target_os = "macos"))]
pub const ICON_WIDTH: u32 = 32;
#[cfg(not(target_os = "macos"))]
pub const ICON_HEIGHT: u32 = 32;

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
#[cfg(target_os = "macos")]
const MARK_PNG: &[u8] = include_bytes!("../assets/tray-mark.png");
/// The same mark, black with alpha, centered in 32 x 32 with room above it for the attention dot.
/// Regenerate: `sed 's/currentColor/#000/' packages/brand/src/aio-proxy-mark.svg > mark.svg`, then draw
/// it into a 32 x 32 transparent bitmap (macOS: a short Swift `NSImage(contentsOfFile:).draw(in:)`
/// script writing PNG; or `rsvg-convert -w 32 -h 32 mark.svg`).
#[cfg(not(target_os = "macos"))]
const MARK_PNG: &[u8] = include_bytes!("../assets/tray-mark-square.png");

/// Where the attention dot sits: (x, y, radius) at the mark's top right.
#[cfg(target_os = "macos")]
const DOT: (f32, f32, f32) = (53.5, 9.5, 3.5);
#[cfg(not(target_os = "macos"))]
const DOT: (f32, f32, f32) = (27.0, 6.0, 3.0);

/// Pixels in `color`: the mark (running), the mark dimmed (down), the mark with a dot at its top right
/// (attention). On macOS this is a template image (AppKit tints it for light and dark menu bars, so
/// the color is black); elsewhere the caller picks the color that contrasts with the panel behind it.
pub fn icon_rgba(state: TrayState, color: [u8; 3]) -> Vec<u8> {
    let mark = image::load_from_memory_with_format(MARK_PNG, image::ImageFormat::Png)
        .expect("the bundled tray mark decodes")
        .to_rgba8();
    let (dot_x, dot_y, dot_r) = DOT;
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
        rgba.extend_from_slice(&[color[0], color[1], color[2], (alpha * 255.0).round() as u8]);
    }
    rgba
}

fn icon(state: TrayState, color: [u8; 3]) -> Icon {
    Icon::from_rgba(icon_rgba(state, color), ICON_WIDTH, ICON_HEIGHT).expect("icon buffer matches its size")
}

pub struct Tray {
    pub icon: TrayIcon,
    /// What the icon currently shows; the color changes with the system theme off macOS.
    shown: Option<(TrayState, [u8; 3])>,
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

/// Creates the icon unless it exists. Linux may have no tray host (yet): that is no-tray mode, and
/// the icon comes when a host appears (`AppEvent::TrayHost`).
pub fn install(cx: &mut App, events: UnboundedSender<AppEvent>) {
    if cx.has_global::<Tray>() {
        return;
    }
    match build(cx, events) {
        Ok(tray) => {
            cx.set_global(tray);
            sync(cx);
        }
        Err(error) if cfg!(target_os = "linux") => crate::log::info(format!("tray: no icon: {error}")),
        Err(error) => panic!("create the menu-bar icon: {error}"),
    }
}

/// Must run on the main thread inside the GPUI `run` callback.
fn build(cx: &App, events: UnboundedSender<AppEvent>) -> Result<Tray, String> {
    let color = crate::platform::tray_color(cx);
    let builder = TrayIconBuilder::new().with_icon(icon(TrayState::Down, color));
    #[cfg(target_os = "macos")]
    let builder = builder.with_icon_as_template(true);
    let icon =
        builder.with_tooltip("AIO Proxy").with_menu_on_left_click(false).build().map_err(|error| error.to_string())?;
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
    Ok(Tray { icon, shown: Some((TrayState::Down, color)), entries: Vec::new() })
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
    let cli = match model.cli_probe {
        _ if model.cli_installing => CliOffer::Installing,
        Some(probe) if !probe.aiop => {
            if !model.can_link_cli() {
                CliOffer::Blocked(if cfg!(target_os = "macos") {
                    "Install aiop command (move to /Applications first)"
                } else {
                    "Install aiop command (unavailable from this location)"
                })
            } else if !probe.link_dir_on_path {
                // The link would not make `aiop` resolve, and the offer would come straight back.
                CliOffer::Blocked(if cfg!(target_os = "macos") {
                    "Install aiop command (/usr/local/bin is not on your PATH)"
                } else {
                    "Install aiop command (~/.local/bin is not on your PATH)"
                })
            } else {
                CliOffer::Ready
            }
        }
        _ => CliOffer::Hidden,
    };
    let mut entries =
        menu_entries(offered, dashboard, model.action.is_busy(), model.persistent(), model.login_item, cli);
    if cfg!(target_os = "linux") {
        // Many hosts show nothing on a left click, so the menu is the way in.
        entries
            .insert(0, MenuEntry::Item { command: MenuCommand::OpenPanel, label: "Open Panel".into(), enabled: true });
    }
    entries
}

/// Runs a menu command, from the right-click menu or the panel's `⋯` menu.
pub fn run(cx: &mut App, command: MenuCommand) {
    match command {
        MenuCommand::OpenPanel => crate::panel::show(cx),
        MenuCommand::OpenDashboard => crate::app::open_dashboard(cx),
        MenuCommand::Run(action) => crate::app::run_user_action(cx, action),
        MenuCommand::OpenLogs => crate::app::open_logs(cx),
        MenuCommand::InstallCli => crate::app::install_cli(cx),
        MenuCommand::ToggleLogin => crate::app::toggle_login_item(cx),
        MenuCommand::CheckForUpdates => crate::platform::updater::check_now(),
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
    let shown = (state, crate::platform::tray_color(cx));
    let Some(tray) = cx.try_global::<Tray>() else {
        return;
    };
    if tray.shown != Some(shown) {
        let icon = icon(shown.0, shown.1);
        #[cfg(target_os = "macos")]
        let _ = tray.icon.set_icon_with_as_template(Some(icon), true);
        #[cfg(not(target_os = "macos"))]
        let _ = tray.icon.set_icon(Some(icon));
        cx.global_mut::<Tray>().shown = Some(shown);
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
