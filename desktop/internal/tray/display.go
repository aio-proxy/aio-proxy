package tray

import (
	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
	"github.com/egoist/mygo"
)

func displayMenu(m *app.Model) []*mygo.MenuItem {
	p := m.MenuBarDisplay
	toggle := func(label string, option menubar.Option) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, Type: mygo.MenuItemCheckbox, Checked: p.Selected(option), Disabled: p.Toggle(option) == p, Click: func(item *mygo.MenuItem, _ *mygo.Window) {
			m.ToggleMenuBarDisplay(option)
			item.SetChecked(m.MenuBarDisplay.Selected(option))
		}}
	}
	items := []*mygo.MenuItem{
		toggle("Today Tokens", menubar.TodayTokens),
		toggle("Tokens per Second", menubar.TokensPerSecond),
		{Label: "Today Cost", Disabled: true, ToolTip: "Not available from the desktop summary."},
		{Label: "Requests in Flight", Disabled: true, ToolTip: "Not available from the desktop summary."},
		mygo.Separator(),
		toggle("Show Icon", menubar.ShowIcon),
	}
	if m.MenuBarDisplayError != "" {
		items = append(items, mygo.Separator(), &mygo.MenuItem{Label: m.MenuBarDisplayError, Disabled: true})
	}
	return items
}
