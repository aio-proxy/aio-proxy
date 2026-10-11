package tray

import (
	"github.com/egoist/mygo"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/loginitem"
)

type CommandKind int

const (
	OpenDashboard CommandKind = iota
	Service
	OpenLogs
	ToggleLogin
	CheckForUpdates
	Quit
	MenuBarDisplay
)

type MenuCommand struct {
	Kind   CommandKind
	Action policy.UserAction
}
type MenuEntry struct {
	Command                            MenuCommand
	Label                              string
	Enabled, Checked, Check, Separator bool
}

func MenuEntries(offered policy.Offered, dashboard, busy, persistent bool, login loginitem.LoginItemStatus) []MenuEntry {
	entries := []MenuEntry{{Command: MenuCommand{Kind: OpenDashboard}, Label: "Open Dashboard", Enabled: dashboard}, {Separator: true}}
	services := []struct {
		show   bool
		action policy.UserAction
		label  string
	}{
		{offered.Install, policy.UserInstallAndStart, "Install and start"},
		{offered.TakeOver, policy.UserTakeOver, "Take over and start"},
		{offered.Start, policy.UserStart, "Start"},
		{offered.Stop, policy.UserStop, "Stop"},
		{offered.Restart, policy.UserRestart, "Restart"},
		{offered.Reload, policy.UserReload, "Reload config"},
	}
	for _, s := range services {
		if s.show {
			entries = append(entries, MenuEntry{Command: MenuCommand{Kind: Service, Action: s.action}, Label: s.label, Enabled: !busy})
		}
	}
	entries = append(entries, MenuEntry{Command: MenuCommand{Kind: MenuBarDisplay}, Label: "Menu Bar Display", Enabled: true}, MenuEntry{Command: MenuCommand{Kind: OpenLogs}, Label: "Open logs", Enabled: true}, MenuEntry{Separator: true})
	label := "Open at login"
	if !persistent {
		label += " (move to Applications first)"
	} else if login == loginitem.RequiresApproval {
		label += " (needs approval)"
	}
	entries = append(entries,
		MenuEntry{Command: MenuCommand{Kind: ToggleLogin}, Label: label, Check: true, Checked: persistent && (login == loginitem.Enabled || login == loginitem.RequiresApproval), Enabled: persistent},
		MenuEntry{Command: MenuCommand{Kind: CheckForUpdates}, Label: "Check for Updates…", Enabled: true},
		MenuEntry{Separator: true},
		MenuEntry{Command: MenuCommand{Kind: Quit}, Label: "Quit AIO Proxy", Enabled: true},
	)
	return entries
}
func Entries(m *app.Model) []MenuEntry {
	offered := policy.Offered{}
	if m.Discovery != nil {
		offered = policy.OfferedActions(m.Discovery, m.Persistent())
	}
	return MenuEntries(offered, !m.IsDown(), m.Action.IsBusy(), m.Persistent(), m.LoginItem)
}
func Run(m *app.Model, command MenuCommand) {
	switch command.Kind {
	case OpenDashboard:
		m.OpenDashboard()
	case Service:
		m.RunUserAction(command.Action)
	case OpenLogs:
		m.OpenLogs()
	case ToggleLogin:
		m.ToggleLoginItem()
	case CheckForUpdates:
		if m.CheckUpdates != nil {
			m.CheckUpdates()
		}
	// Quitting leaves the proxy running: launchd owns it.
	case Quit:
		if m.Quit != nil {
			m.Quit()
		}
	}
}
func nativeMenu(m *app.Model, entries []MenuEntry) *mygo.Menu {
	items := make([]*mygo.MenuItem, 0, len(entries))
	for _, entry := range entries {
		if entry.Separator {
			items = append(items, mygo.Separator())
			continue
		}
		if entry.Command.Kind == MenuBarDisplay {
			items = append(items, &mygo.MenuItem{Label: entry.Label, Submenu: displayMenu(m)})
			continue
		}
		item := &mygo.MenuItem{Label: entry.Label, Disabled: !entry.Enabled, Checked: entry.Checked}
		if entry.Check {
			item.Type = mygo.MenuItemCheckbox
		}
		item.Click = func(it *mygo.MenuItem, _ *mygo.Window) {
			Run(m, entry.Command)
			// The native menu toggles before the callback; approval pending or a failed change may leave
			// the model unchanged. Restore the real state rather than caching that native toggle.
			if entry.Check {
				it.SetChecked(m.Persistent() && (m.LoginItem == loginitem.Enabled || m.LoginItem == loginitem.RequiresApproval))
			}
		}
		items = append(items, item)
	}
	return mygo.NewMenu(items)
}
func NativeMenu(m *app.Model) *mygo.Menu { return nativeMenu(m, Entries(m)) }
