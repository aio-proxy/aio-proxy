package app

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	"runtime"

	"github.com/aio-proxy/aio-proxy/desktop/internal/clicommand"
	"github.com/aio-proxy/aio-proxy/desktop/internal/client/refresh"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/cli"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/run"
	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
	"github.com/aio-proxy/aio-proxy/desktop/internal/login"
	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
)

func (m *Model) Start() {
	m.startLive()
	paths, bundle := m.Paths, m.Bundle
	// Discovery runs alongside the install step. Nothing automatic can start until that step lands:
	// Persistent is false while Install is still nil.
	m.Rediscover()
	go func() {
		state := install.Startup(paths, bundle)
		m.post(func() {
			logx.Infof("install: %+v", state)
			// Only a newer stable copy changes which CLI discovers. Otherwise keep the discovery
			// already taken, or the one still in flight.
			rerun := state.Kind == install.StateReadOnly && state.Reason.Kind == install.ReadOnlyNewerCopy ||
				(m.Discovery == nil && !m.discovering)
			m.Install = &state
			if err := login.Refresh(); err != nil {
				logx.Infof("login item refresh: %v", err)
			}
			m.LoginItem = login.Current()
			m.notify()
			if rerun {
				m.Rediscover()
			} else {
				m.maybeAutomatic()
			}
			m.probeCLI()
		})
	}()
}
func (m *Model) host() (*cli.SystemHost, bool) { return cli.NewSystemHost(m.Paths, m.Bundle) }
func (m *Model) Rediscover() {
	if m.discovering {
		m.rediscoverAgain = true
		return
	}
	host, ok := m.host()
	if !ok {
		m.DiscoveryError = "The bundled aio-proxy binary was not found."
		m.notify()
		return
	}
	m.discovering = true
	seq := m.discoveryOrder.issue()
	go func() {
		result, err := host.Discover()
		m.post(func() {
			m.discovering = false
			again := m.rediscoverAgain
			m.rediscoverAgain = false
			m.applyDiscovery(seq, result, err)
			if again {
				m.Rediscover()
			}
		})
	}()
}
func (m *Model) applyAfter(after discovery.Discovery) {
	if after.Instance.Reachable {
		m.Health.MarkUp()
	}
	m.applyDiscovery(m.discoveryOrder.issue(), after, nil)
}
func (m *Model) applyDiscovery(seq uint64, d discovery.Discovery, err error) {
	if !m.discoveryOrder.accept(seq) {
		return
	}
	first := m.Discovery == nil
	if err != nil {
		logx.Infof("discovery failed: %v", err)
		m.DiscoveryError = err.Error()
	} else {
		m.DiscoveryError = ""
		m.Discovery = &d
	}
	m.instanceMaybeChanged()
	// After an error the stored discovery predates it; never spend the automatic slot on that.
	if err == nil {
		m.maybeAutomatic()
	}
	m.notify()
	if first && m.Discovery != nil {
		m.CheckHealth()
	}
}
func afterAutomaticFailure(action policy.AutoAction, err error) ActionState {
	if errors.Is(err, run.ErrChanged) {
		return ActionState{}
	}
	return ActionState{Kind: ActionFailed, Note: fmt.Sprintf("%s failed: %v", action.Label(), err)}
}
func (m *Model) maybeAutomatic() {
	if m.Action.IsBusy() || m.Discovery == nil {
		return
	}
	d := *m.Discovery
	action, ok := policy.AutomaticAction(&d, m.Persistent(), &m.attempts)
	if !ok {
		return
	}
	host, ok := m.host()
	if !ok {
		return
	}
	worker := m.attempts
	m.attempts.Mark(action)
	m.Action = ActionState{Kind: ActionAutomatic, Auto: action}
	logx.Infof("automatic action: %v", action)
	go func() {
		after, err := run.RunAuto(host, &d, action, &worker)
		m.post(func() {
			if err == nil {
				logx.Infof("automatic action %v finished", action)
				m.Action = ActionState{}
				m.applyAfter(after)
				m.trigger(refresh.ActionDone)
			} else {
				logx.Infof("automatic action %v failed: %v", action, err)
				m.Action = afterAutomaticFailure(action, err)
				m.notify()
				m.Rediscover()
			}
			m.CheckHealth()
		})
	}()
}
func (m *Model) RunUserAction(action policy.UserAction) {
	if m.Action.IsBusy() {
		return
	}
	if action != policy.UserReload && !m.Persistent() {
		logx.Infof("%v refused: this copy is not in a persistent location", action)
		return
	}
	host, ok := m.host()
	if !ok || m.Discovery == nil {
		return
	}
	d := *m.Discovery
	m.Action = ActionState{Kind: ActionRunning, User: action}
	m.notify()
	go func() {
		note, after, err := execute(host, &d, action)
		m.post(func() {
			if err == nil {
				if action == policy.UserStop {
					m.Health.MarkDown()
				}
				m.Action = ActionState{Kind: ActionDone, Note: note}
				if after != nil {
					m.applyAfter(*after)
				}
				m.trigger(refresh.ActionDone)
				m.notify()
			} else {
				logx.Infof("%v failed: %v", action, err)
				if action != policy.UserReload {
					m.attempts.Spend()
				}
				m.Action = ActionState{Kind: ActionFailed, Note: err.Error()}
				m.notify()
				m.Rediscover()
			}
			m.CheckHealth()
		})
	}()
}
func execute(host run.Host, d *discovery.Discovery, action policy.UserAction) (string, *discovery.Discovery, error) {
	if action == policy.UserReload {
		outcome, err := run.RunReload(host, d)
		if err != nil {
			return "", nil, err
		}
		switch outcome.Kind {
		case policy.Reloaded:
			return "Configuration reloaded.", nil, nil
		case policy.Rejected:
			stage := ""
			if outcome.Stage != "" {
				stage = " at " + outcome.Stage
			}
			return "", nil, fmt.Errorf("Reload rejected%s: %s", stage, outcome.Error)
		default:
			return "", nil, errors.New(outcome.Error)
		}
	}
	after, err := run.RunUser(host, d, action)
	if err != nil {
		return "", nil, err
	}
	return action.Label() + " finished.", &after, nil
}
func dashboardURL(base string, segments []string) (string, bool) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || (len(segments) > 0 && (u.Opaque != "" || u.Host == "")) {
		return "", false
	}
	if len(segments) > 0 {
		escaped := strings.TrimSuffix(u.EscapedPath(), "/")
		for _, s := range segments {
			escaped += "/" + url.PathEscape(s)
		}
		u.Path, _ = url.PathUnescape(escaped)
		u.RawPath = escaped
	}
	return u.String(), true
}
func (m *Model) openDashboardAt(segments ...string) {
	if m.Discovery == nil || m.Discovery.Instance.DashboardURL == "" {
		return
	}
	base := m.Discovery.Instance.DashboardURL
	if target, ok := dashboardURL(base, segments); ok {
		base = target
	}
	if m.OpenURL != nil {
		m.OpenURL(base)
	}
}
func (m *Model) OpenDashboard()                  { m.openDashboardAt() }
func (m *Model) OpenDashboardProviders()         { m.openDashboardAt("providers", "") }
func (m *Model) OpenDashboardProvider(id string) { m.openDashboardAt("providers", id, "edit") }
func (m *Model) OpenLogs() {
	home := filepath.Join(m.Paths.Home, ".aio-proxy")
	if m.Discovery != nil && m.Discovery.Unit.Home != "" {
		home = m.Discovery.Unit.Home
	}
	if m.RevealPath != nil {
		m.RevealPath(filepath.Join(home, "logs"))
	}
}
func (m *Model) CanLinkCLI() bool {
	if runtime.GOOS != "darwin" {
		return m.Persistent()
	}
	// /usr/local/bin/aiop is shared by every account, so it may only point into /Applications.
	return m.Persistent() && strings.HasPrefix(m.Bundle, "/Applications")
}
func (m *Model) probeCLI() {
	go func() {
		probe := clicommand.Query()
		m.post(func() {
			logx.Infof("shell probe: %+v", probe)
			m.CLIProbe = probe
			m.notify()
		})
	}()
}
func (m *Model) InstallCLI() {
	if !m.CanLinkCLI() || m.CLIInstalling {
		return
	}
	target := m.Paths.Symlink
	if runtime.GOOS == "darwin" {
		if m.Bundle == "" {
			return
		}
		// The command points at this bundle's CLI, which Sparkle updates in place.
		target = install.SidecarOf(m.Bundle)
	}
	aiop := clicommand.AiopPath(m.Paths.Home, target)
	m.CLIInstalling = true
	m.notify()
	go func() {
		var installed bool
		var installErr error
		// The cached probe may date from launch. Ask again before changing anything.
		if probe := clicommand.Query(); probe != nil && !probe.Aiop && probe.LinkDirOnPath {
			installed, installErr = clicommand.Install(target, !probe.AioProxy)
		}
		m.post(func() {
			logx.Infof("install aiop: %v %v", installed, installErr)
			m.CLIInstalling = false
			if !m.Action.IsBusy() {
				switch {
				case installErr != nil:
					m.Action = ActionState{Kind: ActionFailed, Note: "Install aiop failed: " + installErr.Error()}
				case installed:
					m.Action = ActionState{Kind: ActionDone, Note: clicommand.InstalledNotice(aiop)}
				}
			}
			m.notify()
			m.probeCLI()
		})
	}()
}
func (m *Model) refreshLoginItem() {
	status := login.Current()
	if m.LoginItem == status {
		return
	}
	m.LoginItem = status
	m.notify()
}
func (m *Model) SetLoginItem(enabled bool) {
	if !m.Persistent() {
		return
	}
	m.LoginItemError = ""
	if err := login.SetEnabled(enabled); err != nil {
		m.LoginItemError = "Launch at login: " + err.Error()
	}
	m.LoginItem = login.Current()
	m.notify()
}
func (m *Model) ToggleLoginItem() {
	if m.LoginItem == login.RequiresApproval {
		login.OpenSettings()
	} else {
		m.SetLoginItem(m.LoginItem != login.Enabled)
	}
	m.LoginItem = login.Current()
	m.notify()
}
