//! Design tokens: the Tailwind palette and the shadcn tokens the Dashboard uses, as constants, and
//! the panel's colors built from them for the system's light or dark appearance.

pub mod shadcn;
pub mod tailwind;

use gpui_kit::component::{Colorize, Theme, ThemeMode, oklch};
use gpui_kit::{App, Global, Hsla, WindowAppearance};

use tailwind::*;

/// A CSS `oklch(L C H / A)` color, kept as written so the constants read like the CSS they mirror.
/// GPUI renders in sRGB, so an out-of-gamut value is clipped per channel when converted.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklch {
    pub l: f32,
    pub c: f32,
    pub h: f32,
    pub a: f32,
}

impl Oklch {
    pub const fn new(l: f32, c: f32, h: f32) -> Self {
        Self { l, c, h, a: 1.0 }
    }

    pub const fn alpha(self, a: f32) -> Self {
        Self { a, ..self }
    }
}

impl From<Oklch> for Hsla {
    fn from(color: Oklch) -> Self {
        oklch(color.l, color.c, color.h).opacity(color.a)
    }
}

/// What the panel paints with. Read it through [`colors`].
pub struct PanelColors {
    /// The popover color, opaque: the group cards, the sticky group header, and gaps that read
    /// as the card. The panel itself paints no fill; the window's popover material shows through
    /// around the cards.
    ///
    /// GPUI blends alpha additively (`One`/`One`), so anti-aliased edges drawn over a
    /// translucent fill come out too opaque and dark-rimmed. Edges over a cleared or an opaque
    /// fill are right, so no translucent fill sits under other content.
    pub surface: Hsla,
    pub foreground: Hsla,
    /// Card and segmented-control fill.
    pub muted: Hsla,
    pub muted_foreground: Hsla,
    pub border: Hsla,
    pub primary: Hsla,
    /// The selected card, as shadcn's checked radio card: `bg-primary/5` over the popover, and a
    /// `border-primary/30` edge.
    pub selected: Hsla,
    pub selected_border: Hsla,
    /// The empty part of a share or quota bar.
    pub track: Hsla,
    /// Alert and error text.
    pub danger: Hsla,
    /// A mark that went the good way: a falling failure count, a quota on pace.
    pub success: Hsla,
    /// A mark that went the bad way.
    pub error: Hsla,
    /// The running-with-alerts dot and a low quota.
    pub warning: Hsla,
    pub bar: Hsla,
    /// `--chart-1` .. `--chart-5`, lightest to darkest: the trend's series, Other first.
    pub chart: [Hsla; 5],
    /// Heatmap levels 0 (no tokens) to 4.
    pub heat: [Hsla; 5],
}

impl Global for PanelColors {}

impl PanelColors {
    fn new(dark: bool) -> Self {
        let t = if dark { &shadcn::DARK } else { &shadcn::LIGHT };
        let pick = |light: Oklch, dark_value: Oklch| Hsla::from(if dark { dark_value } else { light });
        Self {
            surface: t.popover.into(),
            foreground: t.popover_foreground.into(),
            muted: t.muted.into(),
            muted_foreground: t.muted_foreground.into(),
            border: t.border.into(),
            primary: t.primary.into(),
            selected: Hsla::from(t.primary).mix_oklab(t.popover.into(), 0.05),
            selected_border: Hsla::from(t.primary).opacity(0.3),
            track: pick(OLIVE_200, OLIVE_700),
            danger: t.destructive.into(),
            success: t.chart_success.into(),
            error: t.chart_error.into(),
            warning: pick(AMBER_600, AMBER_400),
            bar: t.chart[2].into(),
            chart: t.chart.map(Hsla::from),
            // The Dashboard's teal ramp, run toward the background's opposite so level 4 stands out.
            heat: if dark {
                [OLIVE_800, TEAL_900, TEAL_700, TEAL_500, TEAL_300].map(Hsla::from)
            } else {
                [OLIVE_200, TEAL_200, TEAL_400, TEAL_600, TEAL_800].map(Hsla::from)
            },
        }
    }
}

pub fn colors(cx: &App) -> &PanelColors {
    cx.global::<PanelColors>()
}

/// Installs the tokens for `appearance`, both for the panel and for GPUI components (buttons,
/// scrollbars) that read the GPUI theme.
pub fn apply(appearance: WindowAppearance, cx: &mut App) {
    let dark = matches!(appearance, WindowAppearance::Dark | WindowAppearance::VibrantDark);
    // `change` reloads the mode's built-in colors, so the token edits go in a second update.
    Theme::change(if dark { ThemeMode::Dark } else { ThemeMode::Light }, None, cx);
    let t = if dark { &shadcn::DARK } else { &shadcn::LIGHT };
    Theme::update(cx, |theme| {
        let c = &mut theme.colors;
        c.background = t.popover.into();
        c.foreground = t.popover_foreground.into();
        c.popover = t.popover.into();
        c.popover_foreground = t.popover_foreground.into();
        // Accordion items paint this; the panel's Quota blocks show the panel's glass through.
        c.accordion = gpui_kit::transparent_black();
        c.muted = t.muted.into();
        c.muted_foreground = t.muted_foreground.into();
        c.accent = t.accent.into();
        c.accent_foreground = t.accent_foreground.into();
        c.border = t.border.into();
        c.input = t.input.into();
        c.ring = t.ring.into();
        c.danger = t.destructive.into();
        c.primary = t.primary.into();
        c.primary_foreground = t.primary_foreground.into();
        c.button_primary = t.primary.into();
        // shadcn's button hover is `bg-primary/90`.
        c.button_primary_hover = Hsla::from(t.primary).opacity(0.9);
        c.button_primary_active = t.primary.into();
        c.button_primary_foreground = t.primary_foreground.into();
        c.secondary = t.secondary.into();
        c.secondary_foreground = t.secondary_foreground.into();
        [c.chart_1, c.chart_2, c.chart_3, c.chart_4, c.chart_5] = t.chart.map(Hsla::from);
        // `TabBar::segmented`: the muted track, a popover-colored thumb, muted to foreground text.
        c.tab_bar_segmented = t.muted.into();
        c.tab_foreground = t.muted_foreground.into();
        c.tab_active_foreground = t.foreground.into();
    });
    cx.set_global(PanelColors::new(dark));
}

#[cfg(test)]
mod tests;
