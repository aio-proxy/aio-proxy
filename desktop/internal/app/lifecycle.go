package app

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/aio-proxy/aio-proxy/desktop/internal/client/refresh"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/cli"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/run"
	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/loginitem"
	"github.com/aio-proxy/aio-proxy/desktop/internal/version"
)

func (m *Model) Start() {
	m.menuBarStarted = true
	m.refreshMenuBar()
	paths, bundle := m.Paths, m.Bundle
	go func() {
		state := install.InstallState{Kind: install.StateReadOnly, Reason: install.ReadOnlyReason{Kind: install.ReadOnlyLocation}}
		if bundle != "" {
			allowed := install.LocationAllowsPersistence(bundle, paths.Home, install.VolumeIsReadOnly(bundle))
			state = install.Prepare(paths, bundle, allowed, version.App, install.ProbeVersion)
		}
		m.post(func() {
			logx.Infof("install: %+v", state)
			m.Install = &state
			m.LoginItem = loginitem.Status()
			m.notify()
			m.Rediscover()
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
func (m *Model) SetLoginItem(enabled bool) {
	if !m.Persistent() {
		return
	}
	m.LoginItemError = ""
	if err := loginitem.SetEnabled(enabled); err != nil {
		m.LoginItemError = "Launch at login: " + err.Error()
	}
	m.LoginItem = loginitem.Status()
	m.notify()
}
func (m *Model) ToggleLoginItem() {
	if m.LoginItem == loginitem.RequiresApproval {
		loginitem.OpenSettings()
	} else {
		m.SetLoginItem(m.LoginItem != loginitem.Enabled)
	}
	m.LoginItem = loginitem.Status()
	m.notify()
}
