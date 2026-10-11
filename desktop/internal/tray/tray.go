// Package tray owns the menu-bar icon and its right-click menu.
package tray

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"slices"

	"github.com/egoist/mygo"

	"github.com/aio-proxy/aio-proxy/desktop/assets"
	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/client/health"
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
	out := image.NewNRGBA(image.Rect(0, 0, IconWidth, IconHeight))
	for y := range IconHeight {
		for x := range IconWidth {
			_, _, _, a := mark.At(x, y).RGBA()
			alpha := float64(a) / 65535
			switch state {
			case Down:
				alpha *= 0.4
			case Attention:
				alpha = max(alpha, min(1, max(0, 4-math.Hypot(float64(x)-53.5, float64(y)-9.5))))
			}
			out.SetNRGBA(x, y, color.NRGBA{A: uint8(math.Round(alpha * 255))})
		}
	}
	return out
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
}

func New(m *app.Model, toggle, hide func()) (*Tray, error) {
	t := &Tray{state: Down, showIcon: true}
	mark, err := png.Decode(bytes.NewReader(assets.TrayMark))
	if err != nil {
		return nil, fmt.Errorf("tray mark: %w", err)
	}
	for _, state := range []State{Running, Down, Attention} {
		im := iconImage(state, mark)
		var output bytes.Buffer
		if err := png.Encode(&output, im); err != nil {
			return nil, fmt.Errorf("tray image: %w", err)
		}
		t.icons[state] = output.Bytes()
		t.marks[state] = im
	}
	icon, err := mygo.NewTray(mygo.TrayOptions{Icon: t.icons[Down], IconIsTemplate: true, ToolTip: "AIO Proxy"})
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
			err = t.Icon.SetIcon(data, true)
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
