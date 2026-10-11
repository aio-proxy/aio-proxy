package tray

import (
	"github.com/egoist/mygo"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
)

func displayMenu(m *app.Model) []*mygo.MenuItem {
	p := m.MenuBarDisplay
	metric := func(label string, id menubar.Metric) *mygo.MenuItem {
		selected := p.Has(id)
		return &mygo.MenuItem{
			Label: label, Type: mygo.MenuItemCheckbox, Checked: selected,
			Disabled: !selected && p.Count() >= 2,
			Click: func(item *mygo.MenuItem, _ *mygo.Window) {
				m.ToggleMenuBarMetric(id)
				item.SetChecked(m.MenuBarDisplay.Has(id))
			},
		}
	}
	items := []*mygo.MenuItem{
		metric("Today Tokens", menubar.TodayTokens),
		metric("Tokens per Second", menubar.TokensPerSecond),
		metric("Today Cost", menubar.TodayCost),
		metric("Requests in Flight", menubar.InFlight),
		mygo.Separator(),
		{
			Label: "Show Icon", Type: mygo.MenuItemCheckbox, Checked: p.ShowsIcon(), Disabled: p.Count() == 0,
			Click: func(item *mygo.MenuItem, _ *mygo.Window) {
				m.ToggleMenuBarIcon()
				item.SetChecked(m.MenuBarDisplay.ShowsIcon())
			},
		},
	}
	if m.MenuBarDisplayError != "" {
		items = append(items, mygo.Separator(), &mygo.MenuItem{Label: m.MenuBarDisplayError, Disabled: true})
	}
	return items
}
