//! `NSWorkspaceDidWakeNotification`: a wake re-checks the proxy's health at once.

use std::ptr::NonNull;

use block2::RcBlock;
use futures::channel::mpsc::UnboundedSender;
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
use objc2_foundation::{NSNotification, NSOperationQueue};

use crate::app::AppEvent;

/// `NSWorkspaceDidWakeNotification` on the main queue, for the life of the app.
pub(super) fn observe_wake(events: UnboundedSender<AppEvent>) {
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
