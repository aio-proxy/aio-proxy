//! The Usage group's trend: bars per bucket stacked by model or by Provider, with a hover tooltip
//! naming each series. Drawn as a `Plot`, as GPUI Kit's stacked bar chart story is: `BarChart`
//! has one series.

use gpui_kit::component::plot::label::TEXT_SIZE;
use gpui_kit::component::plot::scale::{Scale, ScaleBand, ScaleLinear};
use gpui_kit::component::plot::shape::Bar;
use gpui_kit::component::plot::tooltip::{CrossLine, Tooltip, TooltipState};
use gpui_kit::component::plot::{AxisText, IntoPlot, Plot, PlotAxis, axis_gutter};
use gpui_kit::component::*;
use gpui_kit::*;

use crate::panel::format::local_utc_offset;
use crate::panel::usage::{Metric, Series, Split, bucket_labels, format_value, stack};
use crate::panel::view::PanelView;
use crate::summary::{BucketUnit, Provider, Usage};
use gpui_kit::component::tab::TabBar;

const CHART_HEIGHT: f32 = 112.;

/// The trend's series with their colors, bottom first: shared by the chart and the breakdown below it.
pub fn series(view: &PanelView, usage: &Usage, providers: &[Provider], cx: &App) -> Vec<(Series, Hsla)> {
    let theme = crate::theme::colors(cx);
    let series = match view.split {
        Split::Model => stack(&usage.buckets, &usage.trend_by_model, str::to_string, view.metric),
        Split::Provider => {
            stack(&usage.buckets, &usage.trend_by_provider, |id| provider_label(providers, id), view.metric)
        }
    };
    series
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            // The largest series, at the bottom, takes the darkest color; Other the lightest.
            let color = if s.other { theme.chart[0] } else { theme.chart[4 - i.min(3)] };
            (s, color)
        })
        .collect()
}

/// A Provider's service title, with its account when another Provider shares the title; its id
/// once it is gone from config.
fn provider_label(providers: &[Provider], id: &str) -> String {
    let Some(provider) = providers.iter().find(|p| p.id == id) else { return id.to_string() };
    let title = provider.title();
    let shared = providers.iter().filter(|p| p.title() == title).count() > 1;
    match provider.subtitle() {
        Some(subtitle) if shared => format!("{title} · {subtitle}"),
        _ => title,
    }
}

pub fn trend(view: &PanelView, usage: &Usage, series: &[(Series, Hsla)], cx: &Context<PanelView>) -> impl IntoElement {
    let theme = crate::theme::colors(cx);
    let labels = bucket_labels(&usage.buckets, usage.bucket_unit, usage.range, local_utc_offset);
    let per = match usage.bucket_unit {
        BucketUnit::Hour => "per hour",
        BucketUnit::Day => "per day",
    };
    let last = labels.len().saturating_sub(1);
    let axis = if labels.is_empty() { vec![] } else { vec![0, last / 2, last] };

    let panel = cx.entity().downgrade();
    let split = TabBar::new("trend-split")
        .segmented()
        .xsmall()
        .selected_index(Split::ALL.iter().position(|&split| split == view.split).unwrap_or(0))
        .children(Split::ALL.map(Split::label))
        .on_click(move |&index, _, cx| {
            let _ = panel.update(cx, |view, cx| {
                view.split = Split::ALL[index];
                cx.notify();
            });
        });
    let chart = TrendChart {
        axis: axis.into_iter().map(|i| (i, labels[i].clone())).collect(),
        titles: labels.iter().map(|label| format!("{label} · {per}")).collect(),
        series: series.to_vec(),
        metric: view.metric,
        muted: theme.muted_foreground,
        border: theme.border,
    };
    v_flex()
        .gap_1()
        .pt_2()
        .child(h_flex().justify_end().child(split))
        .child(div().h(px(CHART_HEIGHT)).w_full().child(chart))
}

#[derive(IntoPlot)]
struct TrendChart {
    /// Bottom first, with each series' color.
    series: Vec<(Series, Hsla)>,
    /// The tooltip title per bucket.
    titles: Vec<String>,
    /// First, middle and last bucket labels.
    axis: Vec<(usize, String)>,
    metric: Metric,
    muted: Hsla,
    border: Hsla,
}

impl TrendChart {
    fn x(&self, width: f32) -> ScaleBand<usize> {
        ScaleBand::new(0..self.titles.len(), [0., width]).padding_inner(0.25).padding_outer(0.1).max_band_width(28.)
    }

    fn plot_height(bounds: &Bounds<Pixels>) -> f32 {
        bounds.size.height.as_f32() - axis_gutter(px(TEXT_SIZE))
    }
}

impl Plot for TrendChart {
    fn paint(&mut self, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
        let height = Self::plot_height(&bounds);
        let x = self.x(bounds.size.width.as_f32());
        let band = x.band_width();
        let labels = self.axis.iter().filter_map(|(i, text)| {
            let tick = x.tick(i)?;
            Some(AxisText::new(text.clone(), tick + band / 2., self.muted).align(TextAlign::Center))
        });
        PlotAxis::new().x(height).x_label(labels).stroke(self.border).paint(&bounds, window, cx);

        let tops = self.titles.len();
        let max = (0..tops).map(|i| self.series.iter().map(|(s, _)| s.values[i]).sum::<u128>()).max().unwrap_or(0);
        if max == 0 {
            return;
        }
        let y = ScaleLinear::new(vec![0., max as f64], [height, 2.]);
        let mut base = vec![0u128; tops];
        for (series, color) in &self.series {
            let segments: Vec<(usize, f64, f64)> = (0..tops)
                .filter(|&i| series.values[i] > 0)
                .map(|i| (i, base[i] as f64, (base[i] + series.values[i]) as f64))
                .collect();
            for (b, v) in base.iter_mut().zip(&series.values) {
                *b += v;
            }
            let (x, y0, y1, color) = (x.clone(), y.clone(), y.clone(), *color);
            Bar::new()
                .data(segments)
                .band_width(band)
                .cross(move |d| x.tick(&d.0))
                .base(move |d| y0.tick(&d.1).unwrap_or(height))
                .value(move |d| y1.tick(&d.2))
                .fill(move |_, _, _| color)
                .paint(&bounds, window, cx);
        }
    }

    fn id(&self) -> Option<ElementId> {
        Some("usage-trend".into())
    }

    fn tooltip_state(&self, position: Point<Pixels>, bounds: Bounds<Pixels>, _cx: &App) -> Option<TooltipState> {
        // The axis labels are not a bar.
        if position.y.as_f32() > Self::plot_height(&bounds) {
            return None;
        }
        let x = self.x(bounds.size.width.as_f32());
        let index = x.nearest_index(position.x.as_f32());
        let center = x.tick(&index)? + x.band_width() / 2.;
        Some(TooltipState::new(index, point(px(center), position.y), vec![]))
    }

    fn tooltip(
        &self,
        state: &TooltipState,
        cursor: Point<Pixels>,
        bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        let title = self.titles.get(state.index)?;
        let band = self.x(bounds.size.width.as_f32()).band_width();
        let mut tooltip = Tooltip::new(cursor, bounds.size)
            .gap(px(8.))
            .cross_line(CrossLine::new(state.cross_line).height(Self::plot_height(&bounds)).band(px(band)))
            .title(title.clone());
        // Top first, as the stack reads; a series with nothing in this bucket draws no segment, so
        // it gets no row either.
        let mut total = 0;
        for (series, color) in self.series.iter().rev() {
            let value = series.values[state.index];
            if value == 0 {
                continue;
            }
            total += value;
            tooltip = tooltip.row(*color, series.label.clone(), format_value(value, self.metric));
        }
        Some(tooltip.plain_row("Total", format_value(total, self.metric)).into_any_element())
    }
}
