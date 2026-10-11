// Package tray owns the menu-bar icon and its right-click menu.
package tray

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"runtime"
	"slices"

	"github.com/egoist/mygo"

	"github.com/aio-proxy/aio-proxy/desktop/assets"
	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/client/health"
	"github.com/aio-proxy/aio-proxy/desktop/internal/host"
	"github.com/aio-proxy/aio-proxy/desktop/internal/live"
	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
)

type State int

const (
	Running State = iota
	Down
	Attention
)

func TrayState(h health.HealthState, attention bool) State {
	if h != health.Up {
		return Down
	}
	if attention {
		return Attention
	}
	return Running
}

const IconWidth, IconHeight = 58, 36

func iconImage(state State, mark image.Image) *image.NRGBA {
	b := mark.Bounds()
	w, h := b.Dx(), b.Dy()
	// The wide macOS mark keeps its attention dot; a square mark uses the corner.
	dotX, dotY := float64(w)-4.5, 4.5
	if w == IconWidth && h == IconHeight {
		dotX, dotY = 53.5, 9.5
	}
	out := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			_, _, _, a := mark.At(b.Min.X+x, b.Min.Y+y).RGBA()
			alpha := float64(a) / 65535
			switch state {
			case Down:
				alpha *= 0.4
			case Attention:
				alpha = max(alpha, min(1, max(0, 4-math.Hypot(float64(x)-dotX, float64(y)-dotY))))
			}
			out.SetNRGBA(x, y, color.NRGBA{A: uint8(math.Round(alpha * 255))})
		}
	}
	return out
}

func tint(im *image.NRGBA, rgb [3]byte) {
	for i := 0; i < len(im.Pix); i += 4 {
		im.Pix[i] = rgb[0]
		im.Pix[i+1] = rgb[1]
		im.Pix[i+2] = rgb[2]
	}
}

// trayRGB is the mark color outside macOS. macOS tints a template image itself.
func trayRGB() [3]byte {
	switch runtime.GOOS {
	case "windows":
		if trayUsesLightTaskbar() {
			return [3]byte{0, 0, 0}
		}
		return [3]byte{255, 255, 255}
	case "linux":
		return host.TrayColor(os.Getenv("XDG_CURRENT_DESKTOP"), mygo.Theme.IsDark())
	default:
		return [3]byte{0, 0, 0}
	}
}

type Tray struct {
	Icon     *mygo.Tray
	state    State
	icons    [3][]byte
	entries  []MenuEntry
	menu     *mygo.Menu
	display  menubar.Preferences
	rows     [2]menubar.MetricRow
	rowCount int
	showIcon bool
	dimmed   bool
	marks    [3]image.Image
	source   image.Image
	template bool
	color    [3]byte
}

func New(m *app.Model, toggle, hide func()) (*Tray, error) {
	t := &Tray{state: Down, showIcon: true, template: runtime.GOOS == "darwin"}
	raw := assets.TrayMark
	if !t.template {
		raw = assets.TrayMarkSquare
		t.color = trayRGB()
	}
	mark, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("tray mark: %w", err)
	}
	t.source = mark
	if err := t.paint(); err != nil {
		return nil, err
	}
	icon, err := mygo.NewTray(mygo.TrayOptions{Icon: t.icons[Down], IconIsTemplate: t.template, ToolTip: "AIO Proxy"})
	if err != nil {
		return nil, err
	}
	t.Icon = icon
	icon.OnClick(toggle)
	icon.OnRightClick(func() {
		hide()
		t.Sync(m)
		icon.SetMenu(t.menu)
		defer icon.SetMenu(nil)
		icon.PopUpMenu()
	})
	t.Sync(m)
	return t, nil
}

func (t *Tray) paint() error {
	for _, state := range []State{Running, Down, Attention} {
		im := iconImage(state, t.source)
		if !t.template {
			tint(im, t.color)
		}
		var output bytes.Buffer
		if err := png.Encode(&output, im); err != nil {
			return fmt.Errorf("tray image: %w", err)
		}
		t.icons[state] = output.Bytes()
		t.marks[state] = im
	}
	return nil
}

// Recolor rebuilds a non-template icon after the platform theme changes.
func (t *Tray) Recolor() {
	if t.template || t.Icon == nil {
		return
	}
	c := trayRGB()
	if c == t.color {
		return
	}
	t.color = c
	if err := t.paint(); err != nil {
		logx.Infof("tray color: %v", err)
		return
	}
	if err := t.Icon.SetIcon(t.icons[t.state], false); err != nil {
		logx.Infof("tray color: %v", err)
	}
}
func (t *Tray) Sync(m *app.Model) {
	stopped := m.Health.State() == health.Down || m.Discovery == nil || !m.Discovery.Instance.Reachable
	state := TrayState(m.Health.State(), m.NeedsAttention())
	if stopped {
		state = Down
	}
	drawn, showIcon, dimmed := live.Lines(m.MenuBarDisplay, m.Live, m.InstanceEpoch(), stopped)
	var rows [2]menubar.MetricRow
	copy(rows[:], drawn)
	count := len(drawn)
	if state != t.state || rows != t.rows || count != t.rowCount || showIcon != t.showIcon || dimmed != t.dimmed {
		data, err := t.iconFor(state, rows[:count], showIcon, dimmed)
		if err == nil {
			err = t.Icon.SetIcon(data, t.template)
		}
		if err != nil {
			logx.Infof("menu-bar metrics image: %v", err)
		} else {
			t.state, t.rows, t.rowCount, t.showIcon, t.dimmed = state, rows, count, showIcon, dimmed
		}
	}
	entries := TrayEntries(m)
	if !slices.Equal(entries, t.entries) || m.MenuBarDisplay != t.display {
		t.entries = entries
		t.display = m.MenuBarDisplay
		t.menu = TrayNativeMenu(m)
	}
}
