//! The panel's root view: header, the scrolling groups with a sticky group header, and footer.
//! Data renders from the `AppModel` global; only the panel-local picks live here.

use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::component::*;
use gpui_kit::*;

use super::activity::heat_grid;
use super::format::local_utc_offset;
use super::quota::quota_blocks;
use super::usage::Metric;
use super::{footer, groups, header, states, status};
use crate::app::{AppModel, SummaryState};

/// The Quota group's index among the body's children.
const QUOTA_GROUP: usize = 1;

pub struct PanelView {
    _activation: Subscription,
    /// The body's scroll; `top_item` names the group whose header sticks.
    body: ScrollHandle,
    /// The heatmap's horizontal scroll; opened at the latest week once per window.
    pub(super) heat: ScrollHandle,
    heat_scrolled: bool,
    pub(super) metric: Metric,
    pub(super) bar: Option<usize>,
    pub(super) day: Option<i64>,
}

impl PanelView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Click-away closes the panel (passed by hand on 2026-09-30, spike check 2 item 1).
        let activation = cx.observe_window_activation(window, |_, window, cx| {
            if !window.is_window_active() {
                super::window::close(window, cx);
            }
        });
        Self {
            _activation: activation,
            body: ScrollHandle::new(),
            heat: ScrollHandle::new(),
            heat_scrolled: false,
            metric: Metric::default(),
            bar: None,
            day: None,
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
                    .px_3()
                    .child(groups::usage(self, model, now, cx))
                    .child(groups::quota(&blocks, now, cx))
                    .child(groups::activity(self, &grid, cx));
                // GPUI has no `position: sticky`: overlay the header of the group under the top
                // edge. A wheel scroll notifies this view, so the overlay follows the offset.
                let sticky = (self.body.offset().y < px(0.)).then(|| {
                    let group = match self.body.top_item() {
                        0 => groups::usage_header(model, cx),
                        QUOTA_GROUP => groups::quota_header(&blocks, cx),
                        _ => groups::activity_header(self, &grid, cx),
                    };
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .right_0()
                        // Clicks stop here instead of reaching the hidden header below; wheel
                        // events still scroll the body.
                        .block_mouse_except_scroll()
                        .px_3()
                        .bg(cx.theme().background)
                        .border_b_1()
                        .border_color(cx.theme().border)
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
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(header)
            .child(div().mt_2().border_t_1().border_color(cx.theme().border))
            .child(content)
            .child(footer::footer(model, cx))
    }
}
