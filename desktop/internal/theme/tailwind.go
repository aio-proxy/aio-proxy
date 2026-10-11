package theme

import "github.com/egoist/mygo/ui"

// The Tailwind CSS v4.3 palette subset the shadcn tokens use, generated from
// `tailwindcss/theme.css`. Each value is the CSS `oklch(L% C H)` with L as a
// fraction. ui.Oklch keeps a color outside sRGB wide, so a wide-gamut screen
// shows it as the Dashboard's browser does; elsewhere it maps to the nearest
// sRGB color as CSS Color 4 does.
var (
	White = ui.Oklch(1.0, 0.0, 0.0)

	Olive50  = ui.Oklch(0.988, 0.003, 106.5)
	Olive100 = ui.Oklch(0.966, 0.005, 106.5)
	Olive200 = ui.Oklch(0.93, 0.007, 106.5)
	Olive300 = ui.Oklch(0.88, 0.011, 106.6)
	Olive400 = ui.Oklch(0.737, 0.021, 106.9)
	Olive500 = ui.Oklch(0.58, 0.031, 107.3)
	Olive600 = ui.Oklch(0.466, 0.025, 107.3)
	Olive700 = ui.Oklch(0.394, 0.023, 107.4)
	Olive800 = ui.Oklch(0.286, 0.016, 107.4)
	Olive900 = ui.Oklch(0.228, 0.013, 107.4)
	Olive950 = ui.Oklch(0.153, 0.006, 107.1)

	Teal50  = ui.Oklch(0.984, 0.014, 180.72)
	Teal100 = ui.Oklch(0.953, 0.051, 180.801)
	Teal200 = ui.Oklch(0.91, 0.096, 180.426)
	Teal300 = ui.Oklch(0.855, 0.138, 181.071)
	Teal400 = ui.Oklch(0.777, 0.152, 181.912)
	Teal500 = ui.Oklch(0.704, 0.14, 182.503)
	Teal600 = ui.Oklch(0.6, 0.118, 184.704)
	Teal700 = ui.Oklch(0.511, 0.096, 186.391)
	Teal800 = ui.Oklch(0.437, 0.078, 188.216)
	Teal900 = ui.Oklch(0.386, 0.063, 188.416)
	Teal950 = ui.Oklch(0.277, 0.046, 192.524)

	Zinc50  = ui.Oklch(0.985, 0.0, 0.0)
	Zinc100 = ui.Oklch(0.967, 0.001, 286.375)
	Zinc200 = ui.Oklch(0.92, 0.004, 286.32)
	Zinc300 = ui.Oklch(0.871, 0.006, 286.286)
	Zinc400 = ui.Oklch(0.705, 0.015, 286.067)
	Zinc500 = ui.Oklch(0.552, 0.016, 285.938)
	Zinc600 = ui.Oklch(0.442, 0.017, 285.786)
	Zinc700 = ui.Oklch(0.37, 0.013, 285.805)
	Zinc800 = ui.Oklch(0.274, 0.006, 286.033)
	Zinc900 = ui.Oklch(0.21, 0.006, 285.885)
	Zinc950 = ui.Oklch(0.141, 0.005, 285.823)

	Red50  = ui.Oklch(0.971, 0.013, 17.38)
	Red100 = ui.Oklch(0.936, 0.032, 17.717)
	Red200 = ui.Oklch(0.885, 0.062, 18.334)
	Red300 = ui.Oklch(0.808, 0.114, 19.571)
	Red400 = ui.Oklch(0.704, 0.191, 22.216)
	Red500 = ui.Oklch(0.637, 0.237, 25.331)
	Red600 = ui.Oklch(0.577, 0.245, 27.325)
	Red700 = ui.Oklch(0.505, 0.213, 27.518)
	Red800 = ui.Oklch(0.444, 0.177, 26.899)
	Red900 = ui.Oklch(0.396, 0.141, 25.723)
	Red950 = ui.Oklch(0.258, 0.092, 26.042)

	Amber50  = ui.Oklch(0.987, 0.022, 95.277)
	Amber100 = ui.Oklch(0.962, 0.059, 95.617)
	Amber200 = ui.Oklch(0.924, 0.12, 95.746)
	Amber300 = ui.Oklch(0.879, 0.169, 91.605)
	Amber400 = ui.Oklch(0.828, 0.189, 84.429)
	Amber500 = ui.Oklch(0.769, 0.188, 70.08)
	Amber600 = ui.Oklch(0.666, 0.179, 58.318)
	Amber700 = ui.Oklch(0.555, 0.163, 48.998)
	Amber800 = ui.Oklch(0.473, 0.137, 46.201)
	Amber900 = ui.Oklch(0.414, 0.112, 45.904)
	Amber950 = ui.Oklch(0.279, 0.077, 45.635)
)
