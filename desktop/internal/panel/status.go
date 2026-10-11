package panel

import (
	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/theme"
	"github.com/egoist/mygo/ui"
)

// Dot is amber when the running proxy has alerts; a stopped or undiscovered
// instance is neutral rather than an error.
func Dot(m *app.Model, c *ui.Context) ui.Color {
	p := theme.ForDark(c.Theme().Dark)
	if m.Discovery == nil || m.IsStopped() {
		return p.MutedForeground
	}
	if m.IsDown() {
		return p.Danger
	}
	if m.Summary.Kind == app.SummaryReady && m.Summary.Value != nil && len(m.Summary.Value.Alerts) != 0 {
		return p.Warning
	}
	return p.Success
}
