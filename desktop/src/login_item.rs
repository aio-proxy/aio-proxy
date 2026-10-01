//! "App starts at login": `SMAppService.mainAppService` (macOS 13+), reached by name through the
//! ObjC runtime. build.rs links ServiceManagement so the class is loaded.

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_foundation::NSError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginItemStatus {
    NotRegistered,
    Enabled,
    /// Registered, but the user must allow it in System Settings > General > Login Items.
    RequiresApproval,
    NotFound,
    Unavailable,
}

fn service() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"SMAppService")?;
    // SAFETY: `+[SMAppService mainAppService]` returns a non-null autoreleased object (SDK header).
    Some(unsafe { msg_send![class, mainAppService] })
}

pub fn status() -> LoginItemStatus {
    let Some(service) = service() else {
        return LoginItemStatus::Unavailable;
    };
    // SAFETY: `status` is a readonly NSInteger property (SMAppServiceStatus).
    let raw: isize = unsafe { msg_send![&*service, status] };
    match raw {
        0 => LoginItemStatus::NotRegistered,
        1 => LoginItemStatus::Enabled,
        2 => LoginItemStatus::RequiresApproval,
        3 => LoginItemStatus::NotFound,
        _ => LoginItemStatus::Unavailable,
    }
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let service = service().ok_or("ServiceManagement is unavailable")?;
    // SAFETY: both selectors are `- (BOOL)…AndReturnError:(NSError **)`; `_` makes msg_send! pass
    // the out-pointer and turn NO into Err.
    let result: Result<(), Retained<NSError>> = unsafe {
        if enabled {
            msg_send![&*service, registerAndReturnError: _]
        } else {
            msg_send![&*service, unregisterAndReturnError: _]
        }
    };
    result.map_err(|error| error.localizedDescription().to_string())
}

pub fn open_settings() {
    if let Some(class) = AnyClass::get(c"SMAppService") {
        // SAFETY: `+[SMAppService openSystemSettingsLoginItems]` takes no arguments.
        let _: () = unsafe { msg_send![class, openSystemSettingsLoginItems] };
    }
}
