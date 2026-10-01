//! The shadcn tokens from `packages/ui/src/styles.css` (`:root` and `.dark`), which the Dashboard
//! also uses. Keep both in step; the sidebar and page tokens are left out because the app has
//! neither.

use super::Oklch;
use super::tailwind::*;

pub struct Tokens {
    pub background: Oklch,
    pub foreground: Oklch,
    pub card: Oklch,
    pub card_foreground: Oklch,
    pub popover: Oklch,
    pub popover_foreground: Oklch,
    pub primary: Oklch,
    pub primary_foreground: Oklch,
    pub secondary: Oklch,
    pub secondary_foreground: Oklch,
    pub muted: Oklch,
    pub muted_foreground: Oklch,
    pub accent: Oklch,
    pub accent_foreground: Oklch,
    pub destructive: Oklch,
    pub border: Oklch,
    pub input: Oklch,
    pub ring: Oklch,
    pub chart_success: Oklch,
    pub chart_error: Oklch,
    /// `--chart-1` .. `--chart-5`.
    pub chart: [Oklch; 5],
}

pub const LIGHT: Tokens = Tokens {
    background: WHITE,
    foreground: OLIVE_950,
    card: WHITE,
    card_foreground: OLIVE_950,
    popover: WHITE,
    popover_foreground: OLIVE_950,
    primary: TEAL_700,
    primary_foreground: TEAL_50,
    secondary: ZINC_100,
    secondary_foreground: ZINC_900,
    muted: OLIVE_100,
    muted_foreground: OLIVE_500,
    accent: OLIVE_100,
    accent_foreground: OLIVE_900,
    destructive: RED_600,
    border: OLIVE_200,
    input: OLIVE_200,
    ring: OLIVE_400,
    chart_success: TEAL_600,
    chart_error: RED_500,
    chart: [TEAL_300, TEAL_500, TEAL_600, TEAL_700, TEAL_800],
};

pub const DARK: Tokens = Tokens {
    background: OLIVE_950,
    foreground: OLIVE_50,
    card: OLIVE_900,
    card_foreground: OLIVE_50,
    popover: OLIVE_900,
    popover_foreground: OLIVE_50,
    primary: TEAL_800,
    primary_foreground: TEAL_50,
    secondary: ZINC_800,
    secondary_foreground: ZINC_50,
    muted: OLIVE_800,
    muted_foreground: OLIVE_400,
    accent: OLIVE_800,
    accent_foreground: OLIVE_50,
    destructive: RED_400,
    border: WHITE.alpha(0.1),
    input: WHITE.alpha(0.15),
    ring: OLIVE_500,
    chart_success: TEAL_600,
    chart_error: RED_500,
    chart: [TEAL_300, TEAL_500, TEAL_600, TEAL_700, TEAL_800],
};
