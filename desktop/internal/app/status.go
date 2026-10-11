package app

import (
	"fmt"
	"strings"

	"github.com/aio-proxy/aio-proxy/desktop/internal/client/health"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
)

type runState int

const (
	runUnknown runState = iota
	runStopped
	runNotResponding
	runRunning
)

func (m *Model) run() runState {
	if m.Discovery == nil {
		return runUnknown
	}
	d := m.Discovery
	// A live health answer wins over discovery that may be stale after a failed rediscovery.
	if m.Health.State() == health.Up {
		return runRunning
	}
	if m.Health.State() == health.Down || !d.Instance.Reachable {
		if d.Job.Pid == nil {
			return runStopped
		}
		return runNotResponding
	}
	return runRunning
}
func (m *Model) Headline() string {
	if m.Discovery == nil {
		if m.DiscoveryError != "" {
			return "Cannot inspect aio-proxy"
		}
		return "Connecting…"
	}
	switch m.run() {
	case runStopped:
		return "Stopped"
	case runNotResponding:
		return "Not responding"
	default:
		if m.Discovery.Instance.Version != "" {
			return "Running " + m.Discovery.Instance.Version
		}
		return "Running"
	}
}
func (m *Model) IsStopped() bool { return m.run() == runStopped }
func (m *Model) IsOrphaned() bool {
	return m.IsDown() && m.Discovery != nil && m.Discovery.Unit.Owner == discovery.OwnerOrphaned
}
func (m *Model) IsDown() bool { return m.run() == runStopped || m.run() == runNotResponding }
func (m *Model) EndpointLine() string {
	if m.Discovery == nil || m.Discovery.Instance.ControlURL == "" {
		return ""
	}
	d := m.Discovery
	address := strings.TrimRight(strings.TrimPrefix(d.Instance.ControlURL, "http://"), "/")
	owner := ""
	switch d.Unit.Owner {
	case discovery.OwnerDesktop:
		owner = "started by AIO Proxy"
		if d.Job.Disabled {
			owner = "stopped by you"
		}
	case discovery.OwnerExternal:
		owner = "managed by the aio-proxy CLI"
	case discovery.OwnerOrphaned:
		owner = "left by an uninstalled aio-proxy CLI"
	}
	if owner != "" {
		return address + " · " + owner
	}
	return address
}
func (m *Model) Notice() string {
	if m.LoginItemError != "" {
		return m.LoginItemError
	}
	if m.Action.Kind == ActionFailed {
		return m.Action.Note
	}
	if m.Install != nil && m.Install.Kind == install.StateReadOnly {
		r := m.Install.Reason
		switch r.Kind {
		case install.ReadOnlyLocation:
			return "Move AIO Proxy to Applications to let it manage the proxy."
		case install.ReadOnlyNewerCopy:
			return fmt.Sprintf("A newer copy (%s) is installed at %s. This copy is read-only.", r.Version, r.App)
		case install.ReadOnlyUnreadableCopy:
			return fmt.Sprintf("Cannot read the version of %s. This copy is read-only.", r.App)
		case install.ReadOnlySymlinkFailed:
			return "Cannot update the service link: " + r.Err
		}
	}
	if m.DiscoveryError != "" {
		return m.DiscoveryError
	}
	if m.Discovery == nil {
		return ""
	}
	if m.Discovery.Unit.Owner == discovery.OwnerUnknown {
		return "The installed service is not recognised; the app will not change it."
	}
	switch m.Action.Kind {
	case ActionDone:
		return m.Action.Note
	case ActionRunning:
		return m.Action.User.Label() + "…"
	case ActionAutomatic:
		return m.Action.Auto.Label() + "…"
	}
	if m.IsDown() {
		return ""
	}
	if err := m.UsageError(); err != "" {
		return "Couldn't refresh usage · " + err
	}
	return ""
}
func updatedMinutes(minutes int) string { return fmt.Sprintf("Updated %d min ago", minutes) }
