//! The panel's root view: header, the scrolling groups with a sticky group header, and footer.
//! Data renders from the `AppModel` global; only the panel-local picks live here.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::component::*;
use gpui_kit::*;

use super::activity::heat_grid;
use super::format::local_utc_offset;
use super::quota::quota_blocks;
use super::usage::{Metric, Split};
use super::{footer, groups, header, states, status};
use crate::app::{AppModel, SummaryState};

/// The Quota group's index among the body's children.
const QUOTA_GROUP: usize = 1;

pub struct PanelView {
    _activation: Subscription,
    _appearance: Subscription,
    /// The body's scroll; `top_item` names the group whose header sticks.
    body: ScrollHandle,
    /// The heatmap's horizontal scroll; opened at the latest week once per window.
    pub(super) heat: ScrollHandle,
    heat_scrolled: bool,
    pub(super) metric: Metric,
    pub(super) split: Split,
    /// Quota blocks the user opened or closed, by Provider id, until the panel closes.
    pub(super) quota_open: HashMap<String, bool>,
}

impl PanelView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Click-away closes the panel (passed by hand on 2026-09-30, spike check 2 item 1).
        let activation = cx.observe_window_activation(window, |_, window, cx| {
            if !window.is_window_active() {
                super::window::close(window, cx);
            }
        });
        // The window is new on every open, so it also picks up a change made while it was closed.
        crate::theme::apply(window.appearance(), cx);
        let appearance =
            cx.observe_window_appearance(window, |_, window, cx| crate::theme::apply(window.appearance(), cx));
        Self {
            _activation: activation,
            _appearance: appearance,
            body: ScrollHandle::new(),
            heat: ScrollHandle::new(),
            heat_scrolled: false,
            metric: Metric::default(),
            split: Split::default(),
            quota_open: HashMap::new(),
        }
    }

    /// Puts the top of group `index` at the top of the body now, so this render's sticky header
    /// already matches (`scroll_to_top_of_item` would only apply at the next prepaint).
    fn scroll_body_to(&self, index: usize) {
        if let Some(item) = self.body.bounds_for_item(index) {
            let y = (self.body.bounds().top() - item.top()).max(-self.body.max_offset().y);
            self.body.set_offset(point(self.body.offset().x, y));
        }
    }
}

/// A group on its own opaque card, so its content never draws over the translucent glass (see
/// [`crate::theme::PanelColors::surface`]).
fn card(group: impl IntoElement, cx: &App) -> Div {
    let theme = crate::theme::colors(cx);
    // No border: `--border` is lighter than the glass around the card and reads as a pale halo.
    div().px_3().rounded_lg().bg(theme.surface).child(group)
}

impl Render for PanelView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
        let model = cx.global::<AppModel>();
        let summary = match &model.summary {
            SummaryState::Ready(summary) if !status::is_down(model) => Some(summary.as_ref()),
            _ => None,
        };
        let blocks = summary.map(|s| quota_blocks(&s.providers, now)).unwrap_or_default();
        let quota_ids: Vec<String> = blocks.iter().map(|b| b.provider.id.clone()).collect();
        let on_show = cx.listener(|view, _: &ClickEvent, _, cx| {
            view.scroll_body_to(QUOTA_GROUP);
            cx.notify();
        });
        let header = header::header(model, &quota_ids, on_show, cx);
        let content = match summary {
            Some(summary) => {
                let grid = heat_grid(&summary.activity, (now + local_utc_offset(now)).div_euclid(86_400));
                let list = div()
                    .id("panel-body")
                    .size_full()
                    .overflow_y_scroll()
                    .restrict_scroll_to_axis()
                    .track_scroll(&self.body)
                    .flex()
                    .flex_col()
                    // One 8 pt gutter everywhere: the panel edges and between cards. Card padding
                    // (`px_3`) on top of it is the header and footer's `px_5`, so their text lines up.
                    .gap_2()
                    .px_2()
                    .py_2()
                    .child(card(groups::usage(self, model, now, cx), cx))
                    .child(card(groups::quota(self, &blocks, now, cx), cx))
                    .child(card(groups::activity(self, &grid, cx), cx));
                // GPUI has no `position: sticky`: overlay the header of the group under the top
                // edge. A wheel scroll notifies this view, so the overlay follows the offset.
                // Only once the top card's own header has slid past the edge, not within the body's
                // top padding.
                let tucked = self
                    .body
                    .bounds_for_item(self.body.top_item())
                    .is_some_and(|card| card.top() < self.body.bounds().top());
                let sticky = tucked.then(|| {
                    let group = match self.body.top_item() {
                        0 => groups::usage_header(model),
                        QUOTA_GROUP => groups::quota_header(&blocks, cx),
                        _ => groups::activity_header(&grid, cx),
                    };
                    // The top of a group card, over the card scrolling under it.
                    div()
                        .absolute()
                        .top_0()
                        .left_2()
                        .right_2()
                        // Clicks stop here instead of reaching the hidden header below; wheel
                        // events still scroll the body.
                        .block_mouse_except_scroll()
                        .px_3()
                        .bg(crate::theme::colors(cx).surface)
                        .border_b_1()
                        .rounded_t_lg()
                        .border_color(crate::theme::colors(cx).border)
                        .child(group)
                });
                if !self.heat_scrolled {
                    // Prepaint clamps this to the far right edge: the latest week.
                    self.heat.set_offset(point(px(-100_000.), px(0.)));
                    self.heat_scrolled = true;
                }
                div().relative().flex_1().min_h_0().child(list).children(sticky).into_any_element()
            }
            None => states::body(model, cx).into_any_element(),
        };
        v_flex()
            .size_full()
            .text_color(crate::theme::colors(cx).foreground)
            .child(header)
            .child(content)
            .child(footer::footer(model))
    }
}
