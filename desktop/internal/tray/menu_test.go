package tray

import (
	"runtime"
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/clicommand"
	"github.com/aio-proxy/aio-proxy/desktop/internal/client/health"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
	"github.com/aio-proxy/aio-proxy/desktop/internal/login"
)

func entryFor(t *testing.T, entries []MenuEntry, cmd MenuCommand) MenuEntry {
	t.Helper()
	for _, e := range entries {
		if !e.Separator && e.Command == cmd {
			return e
		}
	}
	t.Fatalf("command %+v not offered", cmd)
	return MenuEntry{}
}
func TestBusyOnlyDisablesServiceActions(t *testing.T) {
	entries := MenuEntries(policy.Offered{Restart: true, Stop: true, Reload: true}, true, true, true, login.RequiresApproval, CliOffer{})
	for _, a := range []policy.UserAction{policy.UserRestart, policy.UserStop, policy.UserReload} {
		if entryFor(t, entries, MenuCommand{Kind: Service, Action: a}).Enabled {
			t.Fatalf("busy action %v enabled", a)
		}
	}
	for _, k := range []CommandKind{OpenDashboard, OpenLogs, CheckForUpdates, Quit} {
		if !entryFor(t, entries, MenuCommand{Kind: k}).Enabled {
			t.Fatalf("non-service command %v disabled", k)
		}
	}
	login := entryFor(t, entries, MenuCommand{Kind: ToggleLogin})
	if !login.Enabled || !login.Checked {
		t.Fatal("pending approval lost its enabled check")
	}
}
func TestReadOnlyLoginCannotBeRegistered(t *testing.T) {
	entries := MenuEntries(policy.Offered{Reload: true}, true, false, false, login.Enabled, CliOffer{})
	login := entryFor(t, entries, MenuCommand{Kind: ToggleLogin})
	if login.Enabled || login.Checked {
		t.Fatal("read-only registration enabled")
	}
	if !entryFor(t, entries, MenuCommand{Kind: Service, Action: policy.UserReload}).Enabled {
		t.Fatal("safe reload disabled")
	}
}
func TestDownServiceDisablesDashboardAndDoesNotOfferStop(t *testing.T) {
	entries := MenuEntries(policy.Offered{Start: true}, false, false, true, login.NotRegistered, CliOffer{})
	if entryFor(t, entries, MenuCommand{Kind: OpenDashboard}).Enabled {
		t.Fatal("dead dashboard enabled")
	}
	if !entryFor(t, entries, MenuCommand{Kind: Service, Action: policy.UserStart}).Enabled {
		t.Fatal("start disabled")
	}
	for _, e := range entries {
		if e.Command.Kind == Service && e.Command.Action == policy.UserStop {
			t.Fatal("stop offered for stopped service")
		}
	}
}
func TestSharedMenuOmitsDisplayAndOpenPanel(t *testing.T) {
	entries := MenuEntries(policy.Offered{}, true, false, true, login.Enabled, CliOffer{Visible: true, Label: "Install aiop command", Enabled: true})
	for _, entry := range entries {
		if entry.Command.Kind == MenuBarDisplay || entry.Command.Kind == OpenPanel {
			t.Fatalf("shared menu included %+v", entry.Command)
		}
	}
	got := entryFor(t, entries, MenuCommand{Kind: InstallCli})
	if got.Label != "Install aiop command" || !got.Enabled {
		t.Fatalf("%+v", got)
	}
	hidden := MenuEntries(policy.Offered{}, true, false, true, login.Enabled, CliOffer{})
	for _, entry := range hidden {
		if entry.Command.Kind == InstallCli {
			t.Fatal("hidden cli offer was shown")
		}
	}
}

func TestCliOfferFollowsTheProbe(t *testing.T) {
	persistent := install.InstallState{Kind: install.StatePersistent}
	m := &app.Model{Install: &persistent, Bundle: "/Applications/AIO Proxy.app", CLIProbe: &clicommand.Probe{LinkDirOnPath: true}}
	if got := cliOffer(m); !got.Visible || !got.Enabled || got.Label != "Install aiop command" {
		t.Fatalf("ready %+v", got)
	}
	m.CLIProbe.Aiop = true
	if got := cliOffer(m); got.Visible {
		t.Fatal("an existing aiop is still offered")
	}
	m.CLIProbe = &clicommand.Probe{}
	m.Install = nil
	got := cliOffer(m)
	if !got.Visible || got.Enabled {
		t.Fatalf("blocked %+v", got)
	}
	if runtime.GOOS == "darwin" && got.Label != "Install aiop command (move to /Applications first)" {
		t.Fatalf("label %q", got.Label)
	}
}

func TestOnlyHealthyProxyShowsRunningOrAttention(t *testing.T) {
	for _, h := range []health.HealthState{health.Unknown, health.Down, health.Up} {
		for _, attention := range []bool{false, true} {
			state := TrayState(h, attention)
			if h != health.Up && state != Down {
				t.Fatal("non-healthy instance shown up")
			}
			if h == health.Up && (attention && state != Attention || !attention && state != Running) {
				t.Fatal("healthy state missing attention")
			}
		}
	}
}
