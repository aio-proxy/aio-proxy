//! Sparkle 2.10.0 on the main thread: `SPUStandardUpdaterController` plus a
//! `SPUStandardUserDriverDelegate` with gentle reminders, because a background (`LSUIElement`) app
//! gets none from Sparkle. Updates only ever install through Sparkle's "Install and Relaunch"
//! (`SUAllowsAutomaticUpdates` is false); the relaunched app restarts its proxy through the
//! automatic-action table.

use std::cell::RefCell;

use futures::channel::mpsc::UnboundedSender;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject, NSObjectProtocol};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_foundation::{NSBundle, NSString};

use crate::app::AppEvent;
use crate::log;

pub struct Ivars {
    events: UnboundedSender<AppEvent>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class has no Drop impl.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "AIOProxyUserDriverDelegate"]
    #[ivars = Ivars]
    pub struct UserDriverDelegate;

    impl UserDriverDelegate {
        #[unsafe(method(supportsGentleScheduledUpdateReminders))]
        fn supports_gentle_reminders(&self) -> bool {
            true
        }

        /// Let Sparkle show a scheduled update itself only when it would be in immediate focus;
        /// otherwise the panel and icon carry the reminder.
        #[unsafe(method(standardUserDriverShouldHandleShowingScheduledUpdate:andInImmediateFocus:))]
        fn should_handle_scheduled(&self, _update: &AnyObject, immediate_focus: bool) -> bool {
            immediate_focus
        }

        #[unsafe(method(standardUserDriverWillHandleShowingUpdate:forUpdate:state:))]
        fn will_handle_showing(&self, handle_showing: bool, update: &AnyObject, _state: &AnyObject) {
            if handle_showing {
                return;
            }
            // SAFETY: `SUAppcastItem.displayVersionString` is a non-null NSString property.
            let version: Retained<NSString> = unsafe { msg_send![update, displayVersionString] };
            let _ = self.ivars().events.unbounded_send(AppEvent::UpdateAvailable(version.to_string()));
        }

        #[unsafe(method(standardUserDriverDidReceiveUserAttentionForUpdate:))]
        fn did_receive_attention(&self, _update: &AnyObject) {
            let _ = self.ivars().events.unbounded_send(AppEvent::UpdateAttended);
        }

        #[unsafe(method(standardUserDriverWillFinishUpdateSession))]
        fn will_finish_session(&self) {
            let _ = self.ivars().events.unbounded_send(AppEvent::UpdateAttended);
        }
    }

    unsafe impl NSObjectProtocol for UserDriverDelegate {}
);

thread_local! {
    /// Sparkle holds its delegate weakly; both live for the life of the app.
    static UPDATER: RefCell<Option<(Retained<AnyObject>, Retained<UserDriverDelegate>)>> = const { RefCell::new(None) };
}

/// Both keys are written by the bundle step only when a feed and key are configured.
fn configured() -> bool {
    let bundle = NSBundle::mainBundle();
    ["SUFeedURL", "SUPublicEDKey"].iter().all(|key| {
        bundle
            .objectForInfoDictionaryKey(&NSString::from_str(key))
            .and_then(|value| value.downcast::<NSString>().ok())
            .is_some_and(|value| !value.to_string().is_empty())
    })
}

pub fn start(events: UnboundedSender<AppEvent>) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    if !configured() {
        log::info("updater: disabled (Info.plist has no SUFeedURL/SUPublicEDKey)");
        return;
    }
    let Some(class) = AnyClass::get(c"SPUStandardUpdaterController") else {
        log::info("updater: disabled (Sparkle.framework is not loaded)");
        return;
    };
    let delegate = mtm.alloc::<UserDriverDelegate>().set_ivars(Ivars { events });
    // SAFETY: NSObject's designated initializer.
    let delegate: Retained<UserDriverDelegate> = unsafe { msg_send![super(delegate), init] };
    let none: Option<&AnyObject> = None;
    // SAFETY: `-initWithStartingUpdater:updaterDelegate:userDriverDelegate:` (SPUStandardUpdaterController.h).
    let controller: Retained<AnyObject> = unsafe {
        msg_send![msg_send![class, alloc], initWithStartingUpdater: true, updaterDelegate: none, userDriverDelegate: &*delegate]
    };
    log::info("updater: started");
    UPDATER.with(|slot| *slot.borrow_mut() = Some((controller, delegate)));
}

/// "Check for Updates…" and the panel's update button: brings Sparkle's own alert into focus.
pub fn check_now() {
    UPDATER.with(|slot| {
        if let Some((controller, _)) = &*slot.borrow() {
            let none: Option<&AnyObject> = None;
            // SAFETY: `-[SPUStandardUpdaterController checkForUpdates:]` takes an optional sender.
            let _: () = unsafe { msg_send![&**controller, checkForUpdates: none] };
        }
    });
}

/// The panel's update button. Sparkle's own alert installs, so this brings it up.
pub fn install_now() {
    check_now();
}
