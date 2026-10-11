//go:build !darwin

package tray

import "github.com/aio-proxy/aio-proxy/desktop/internal/menubar"

// Linux and Windows trays are square and have no template text. The icon carries the state alone.
func (t *Tray) iconFor(state State, _ []menubar.MetricRow, _, _ bool) ([]byte, error) {
	return t.icons[state], nil
}
