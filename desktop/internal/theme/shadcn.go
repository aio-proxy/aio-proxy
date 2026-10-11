package theme

import "github.com/egoist/mygo/ui"

// Tokens are the shadcn tokens from `packages/ui/src/styles.css` (`:root` and
// `.dark`), which the Dashboard also uses. Keep both in step; the sidebar and
// page tokens are left out because the app has neither.
type Tokens struct {
	Background          ui.Color
	Foreground          ui.Color
	Card                ui.Color
	CardForeground      ui.Color
	Popover             ui.Color
	PopoverForeground   ui.Color
	Primary             ui.Color
	PrimaryForeground   ui.Color
	Secondary           ui.Color
	SecondaryForeground ui.Color
	Muted               ui.Color
	MutedForeground     ui.Color
	Accent              ui.Color
	AccentForeground    ui.Color
	Destructive         ui.Color
	Border              ui.Color
	Input               ui.Color
	Ring                ui.Color
	ChartSuccess        ui.Color
	ChartError          ui.Color
	// Chart is `--chart-1` .. `--chart-5`.
	Chart [5]ui.Color
}

// Light is `:root`.
var Light = Tokens{
	Background:          White,
	Foreground:          Olive950,
	Card:                White,
	CardForeground:      Olive950,
	Popover:             White,
	PopoverForeground:   Olive950,
	Primary:             Teal700,
	PrimaryForeground:   Teal50,
	Secondary:           Zinc100,
	SecondaryForeground: Zinc900,
	Muted:               Olive100,
	MutedForeground:     Olive500,
	Accent:              Olive100,
	AccentForeground:    Olive900,
	Destructive:         Red600,
	Border:              Olive200,
	Input:               Olive200,
	Ring:                Olive400,
	ChartSuccess:        Teal600,
	ChartError:          Red500,
	Chart:               [5]ui.Color{Teal300, Teal500, Teal600, Teal700, Teal800},
}

// Dark is `.dark`.
var Dark = Tokens{
	Background:          Olive950,
	Foreground:          Olive50,
	Card:                Olive900,
	CardForeground:      Olive50,
	Popover:             Olive900,
	PopoverForeground:   Olive50,
	Primary:             Teal800,
	PrimaryForeground:   Teal50,
	Secondary:           Zinc800,
	SecondaryForeground: Zinc50,
	Muted:               Olive800,
	MutedForeground:     Olive400,
	Accent:              Olive800,
	AccentForeground:    Olive50,
	Destructive:         Red400,
	Border:              White.Alpha(0.1),
	Input:               White.Alpha(0.15),
	Ring:                Olive500,
	ChartSuccess:        Teal600,
	ChartError:          Red500,
	Chart:               [5]ui.Color{Teal300, Teal500, Teal600, Teal700, Teal800},
}
