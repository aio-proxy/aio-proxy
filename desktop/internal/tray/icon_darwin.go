//go:build darwin

package tray

import "image"

import "github.com/aio-proxy/aio-proxy/desktop/internal/menubar"

func (t *Tray) iconFor(state State, rows []menubar.MetricRow, showIcon, dimmed bool) ([]byte, error) {
	if len(rows) == 0 {
		return t.icons[state], nil
	}
	var mark image.Image
	if showIcon {
		mark = t.marks[state]
	}
	return metricsPNG(rows, mark, dimmed)
}
