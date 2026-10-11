// Package theme holds the design tokens: the Tailwind palette and the shadcn
// tokens the Dashboard uses, and the panel's colors built from them for the
// system's light or dark appearance.
package theme

import "github.com/egoist/mygo/ui"

// Palette is what the panel paints with.
type Palette struct {
	// Surface is the popover color, opaque: the group cards, the sticky group
	// header, and gaps that read as the card. The panel itself paints no
	// fill; the window's popover material shows through around the cards.
	Surface    ui.Color
	Foreground ui.Color
	// Muted is the card and segmented-control fill.
	Muted           ui.Color
	MutedForeground ui.Color
	Border          ui.Color
	Primary         ui.Color
	// Selected and SelectedBorder are the selected card, as shadcn's checked
	// radio card: `bg-primary/5` over the popover, and a `border-primary/30`
	// edge.
	Selected       ui.Color
	SelectedBorder ui.Color
	// Track is the empty part of a share or quota bar.
	Track ui.Color
	// Danger is alert and error text.
	Danger ui.Color
	// Success is a mark that went the good way: a falling failure count, a
	// quota on pace.
	Success ui.Color
	// Error is a mark that went the bad way.
	Error ui.Color
	// Warning is the running-with-alerts dot and a low quota.
	Warning ui.Color
	Bar     ui.Color
	// Chart is `--chart-1` .. `--chart-5`, lightest to darkest: the trend's
	// series, Other first.
	Chart [5]ui.Color
	// Heat is the heatmap levels 0 (no tokens) to 4.
	Heat [5]ui.Color

	// The shadcn tokens the Rust app also installed into its component
	// theme, for views that draw those parts themselves.
	PrimaryForeground   ui.Color
	Secondary           ui.Color
	SecondaryForeground ui.Color
	Accent              ui.Color
	AccentForeground    ui.Color
	Input               ui.Color
	Ring                ui.Color
	// TabForeground and TabActiveForeground are a segmented control's text:
	// muted, and the foreground on the selected segment. The segmented
	// track is Muted and its thumb Surface.
	TabForeground       ui.Color
	TabActiveForeground ui.Color
}

// TokensForDark returns the shadcn tokens of the appearance.
func TokensForDark(dark bool) *Tokens {
	if dark {
		return &Dark
	}
	return &Light
}

// ForDark returns the panel's colors for a dark or a light appearance.
func ForDark(dark bool) Palette {
	t := TokensForDark(dark)
	pick := func(light, darkValue ui.Color) ui.Color {
		if dark {
			return darkValue
		}
		return light
	}
	// The Dashboard's teal ramp, run toward the background's opposite so
	// level 4 stands out.
	heat := [5]ui.Color{Olive200, Teal200, Teal400, Teal600, Teal800}
	if dark {
		heat = [5]ui.Color{Olive800, Teal900, Teal700, Teal500, Teal300}
	}
	return Palette{
		Surface:         t.Popover,
		Foreground:      t.PopoverForeground,
		Muted:           t.Muted,
		MutedForeground: t.MutedForeground,
		Border:          t.Border,
		Primary:         t.Primary,
		// 5% primary over the popover, as `bg-primary/5` composites in the
		// Dashboard (the Rust app mixed in Oklab; at 5% the two agree to
		// within a step).
		Selected:       t.Popover.Mix(t.Primary, 0.05),
		SelectedBorder: t.Primary.Alpha(0.3),
		Track:          pick(Olive200, Olive700),
		Danger:         t.Destructive,
		Success:        t.ChartSuccess,
		Error:          t.ChartError,
		Warning:        pick(Amber600, Amber400),
		Bar:            t.Chart[2],
		Chart:          t.Chart,
		Heat:           heat,

		PrimaryForeground:   t.PrimaryForeground,
		Secondary:           t.Secondary,
		SecondaryForeground: t.SecondaryForeground,
		Accent:              t.Accent,
		AccentForeground:    t.AccentForeground,
		Input:               t.Input,
		Ring:                t.Ring,
		TabForeground:       t.MutedForeground,
		TabActiveForeground: t.Foreground,
	}
}

// UITheme returns a copy of base, the window's theme (`c.Theme()`, which
// follows the system's appearance and the desktop's preferences), with the
// shadcn colors of base's appearance, so MyGo's widgets (buttons, tabs,
// collapsibles, scroll bars) match the panel. Set it with `c.SetTheme`.
// Metrics (radius, spacing, font size) and the scroll bar stay base's.
func UITheme(base *ui.Theme) *ui.Theme {
	th := *base
	t := TokensForDark(base.Dark)
	p := ForDark(base.Dark)
	th.Background = t.Popover
	th.Text = t.PopoverForeground
	th.TextMuted = t.MutedForeground
	th.Border = t.Border
	// Controls sit on the muted fill, as the Rust app's segmented track did;
	// hover and press darken it toward the text, as shadcn's `hover:bg-accent`
	// would read over a muted face.
	th.Surface = t.Muted
	th.SurfaceHover = t.Muted.Mix(t.PopoverForeground, 0.06)
	th.SurfacePressed = t.Muted.Mix(t.PopoverForeground, 0.12)
	th.Accent = t.Primary
	// shadcn's button hover is `bg-primary/90`.
	th.AccentHover = t.Primary.Alpha(0.9)
	th.AccentPressed = t.Primary
	th.AccentText = t.PrimaryForeground
	th.Danger = t.Destructive
	th.Warning = p.Warning
	th.Success = p.Success
	th.Selection = t.Primary.Alpha(0.25)
	// shadcn's `focus-visible:ring-ring/50`.
	th.Focus = t.Ring.Alpha(0.5)
	return &th
}
