package tray

import (
	"runtime"

	"github.com/egoist/mygo"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
	"github.com/aio-proxy/aio-proxy/desktop/internal/login"
)

type CommandKind int

const (
	OpenDashboard CommandKind = iota
	OpenPanel
	Service
	OpenLogs
	InstallCli
	ToggleLogin
	CheckForUpdates
	Quit
	MenuBarDisplay
)

// CliOffer is the Install aiop command item. The zero value stays hidden.
type CliOffer struct {
	Visible bool
	Label   string
	Enabled bool
}

type MenuCommand struct {
	Kind   CommandKind
	Action policy.UserAction
}
type MenuEntry struct {
	Command                            MenuCommand
	Label                              string
	Enabled, Checked, Check, Separator bool
}

func MenuEntries(offered policy.Offered, dashboard, busy, persistent bool, loginItem login.Status, cli CliOffer) []MenuEntry {
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
	entries = append(entries, MenuEntry{Command: MenuCommand{Kind: OpenLogs}, Label: "Open logs", Enabled: true})
	if cli.Visible {
		entries = append(entries, MenuEntry{Command: MenuCommand{Kind: InstallCli}, Label: cli.Label, Enabled: cli.Enabled})
	}
	entries = append(entries, MenuEntry{Separator: true})
	label := "Open at login"
	if !persistent {
		label += " (move to Applications first)"
	} else if loginItem == login.RequiresApproval {
		label += " (needs approval)"
	}
	entries = append(entries,
		MenuEntry{Command: MenuCommand{Kind: ToggleLogin}, Label: label, Check: true, Checked: persistent && (loginItem == login.Enabled || loginItem == login.RequiresApproval), Enabled: persistent},
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
	return MenuEntries(offered, !m.IsDown(), m.Action.IsBusy(), m.Persistent(), m.LoginItem, cliOffer(m))
}
func cliOffer(m *app.Model) CliOffer {
	if m.CLIInstalling {
		return CliOffer{Visible: true, Label: "Installing aiop command…", Enabled: false}
	}
	if m.CLIProbe == nil || m.CLIProbe.Aiop {
		return CliOffer{}
	}
	if !m.CanLinkCLI() {
		label := "Install aiop command (unavailable from this location)"
		if runtime.GOOS == "darwin" {
			label = "Install aiop command (move to /Applications first)"
		}
		return CliOffer{Visible: true, Label: label}
	}
	if !m.CLIProbe.LinkDirOnPath {
		label := "Install aiop command (~/.local/bin is not on your PATH)"
		if runtime.GOOS == "darwin" {
			label = "Install aiop command (/usr/local/bin is not on your PATH)"
		}
		return CliOffer{Visible: true, Label: label}
	}
	return CliOffer{Visible: true, Label: "Install aiop command", Enabled: true}
}
func TrayEntries(m *app.Model) []MenuEntry {
	entries := Entries(m)
	if runtime.GOOS == "linux" {
		// Many status-notifier hosts ignore a left click, so the menu is the way in.
		entries = append([]MenuEntry{{Command: MenuCommand{Kind: OpenPanel}, Label: "Open Panel", Enabled: true}}, entries...)
	}
	return entries
}
func Run(m *app.Model, command MenuCommand) {
	switch command.Kind {
	case OpenDashboard:
		m.OpenDashboard()
	case OpenPanel:
		if m.OpenPanel != nil {
			m.OpenPanel()
		}
	case Service:
		m.RunUserAction(command.Action)
	case OpenLogs:
		m.OpenLogs()
	case InstallCli:
		m.InstallCLI()
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
func nativeMenu(m *app.Model, entries []MenuEntry, withDisplay bool) *mygo.Menu {
	items := make([]*mygo.MenuItem, 0, len(entries))
	for _, entry := range entries {
		if entry.Separator {
			items = append(items, mygo.Separator())
			continue
		}
		// The display submenu is the tray's, immediately before Open logs. The panel menu omits it.
		if withDisplay && entry.Command.Kind == OpenLogs {
			items = append(items, &mygo.MenuItem{Label: "Menu Bar Display", Submenu: displayMenu(m)})
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
				it.SetChecked(m.Persistent() && (m.LoginItem == login.Enabled || m.LoginItem == login.RequiresApproval))
			}
		}
		items = append(items, item)
	}
	return mygo.NewMenu(items)
}
func NativeMenu(m *app.Model) *mygo.Menu { return nativeMenu(m, Entries(m), false) }
func TrayNativeMenu(m *app.Model) *mygo.Menu {
	return nativeMenu(m, TrayEntries(m), runtime.GOOS == "darwin")
}
