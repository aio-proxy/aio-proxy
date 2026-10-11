// Package app owns the menu-bar companion's state. Model reads and writes occur on the main thread;
// workers land through Post. Changed lets main refresh the tray and UI without an import cycle.
package app

import (
	"context"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/clicommand"
	"github.com/aio-proxy/aio-proxy/desktop/internal/client/health"
	"github.com/aio-proxy/aio-proxy/desktop/internal/client/refresh"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
	"github.com/aio-proxy/aio-proxy/desktop/internal/live"
	"github.com/aio-proxy/aio-proxy/desktop/internal/login"
	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

type SummaryKind int

const (
	SummaryWaiting SummaryKind = iota
	SummaryReady
	SummaryDegraded
	SummaryAuthFailed
	SummaryUnavailable
)

type SummaryState struct {
	Kind   SummaryKind
	Value  *summary.SummaryV1
	Reason summary.DegradedReason
	Error  string
}

type ActionKind int

const (
	ActionIdle ActionKind = iota
	ActionRunning
	ActionAutomatic
	ActionDone
	ActionFailed
)

type ActionState struct {
	Kind ActionKind
	User policy.UserAction
	Auto policy.AutoAction
	Note string
}

func (a ActionState) IsBusy() bool { return a.Kind == ActionRunning || a.Kind == ActionAutomatic }
func (a *ActionState) ClearOutcome() {
	if a.Kind == ActionDone || a.Kind == ActionFailed {
		*a = ActionState{}
	}
}

type Model struct {
	Paths             install.Paths
	Bundle            string
	Install           *install.InstallState
	Discovery         *discovery.Discovery
	DiscoveryError    string
	Health            health.HealthTracker
	Summary           SummaryState
	SummaryError      string
	SummaryErrorRange summary.UsageRange
	LastSummaryAt     time.Time
	Action            ActionState
	UpdatePending     string
	LoginItem         login.Status
	LoginItemError    string
	UsageRange        summary.UsageRange
	MenuBarDisplay    menubar.Preferences
	Live              live.Display
	// CLIProbe is nil when the shell could not say whether aiop resolves.
	CLIProbe         *clicommand.Probe
	CLIInstalling    bool
	LiveSchedule     live.Schedule
	goneRediscovered time.Time

	// Set before Start. Post runs fn on the main thread. Changed synchronizes the tray and windows.
	Post          func(func())
	Changed       func()
	OpenURL       func(string)
	RevealPath    func(string)
	CheckUpdates  func()
	InstallUpdate func()
	OpenPanel     func()
	Quit          func()

	usageCache            map[summary.UsageRange]*summary.Usage
	attempts              policy.AutoAttempts
	discovering           bool
	discoveryOrder        discoveryOrder
	rediscoverAgain       bool
	authRetryUsed         bool
	refetchAfterDiscovery bool
	scheduler             refresh.Scheduler
	instance              instanceKey
	instanceSet           bool
	instanceEpoch         uint64
	fetchCancel           context.CancelFunc
	timer                 *time.Timer
	healthCancel          context.CancelFunc
	liveCancel            context.CancelFunc
	menuBarCancel         context.CancelFunc
	menuBarGeneration     uint64
	menuBarStarted        bool
	stopped               bool
}
type instanceKey struct {
	URL    string
	PID    uint32
	HasPID bool
}

func NewModel(paths install.Paths, bundle string) *Model {
	p, err := menubar.Load(paths.Support)
	if err != nil {
		logx.Infof("menu bar display preferences: %v", err)
	}
	return &Model{Paths: paths, Bundle: bundle, LoginItem: login.Unavailable, usageCache: make(map[summary.UsageRange]*summary.Usage), MenuBarDisplay: p}
}
func (m *Model) notify() {
	if m.Changed != nil {
		m.Changed()
	}
}
func (m *Model) post(fn func()) {
	m.Post(func() {
		if !m.stopped {
			fn()
		}
	})
}
func (m *Model) UsageFor(r summary.UsageRange) *summary.Usage {
	return m.usageCache[r]
}
func (m *Model) UsageError() string {
	if m.SummaryErrorRange == m.UsageRange {
		return m.SummaryError
	}
	return ""
}
func (m *Model) IsRefreshing() bool { return m.scheduler.IsFetching() }
func (m *Model) UpdatedText() string {
	if m.LastSummaryAt.IsZero() {
		return ""
	}
	minutes := int(time.Since(m.LastSummaryAt) / time.Minute)
	if minutes == 0 {
		return "Updated just now"
	}
	return updatedMinutes(minutes)
}
func (m *Model) InstanceEpoch() uint64 { return m.instanceEpoch }
func (m *Model) Persistent() bool {
	return m.Install != nil && m.Install.Kind == install.StatePersistent
}
func (m *Model) NeedsAttention() bool {
	return m.Summary.Kind == SummaryReady && len(m.Summary.Value.Alerts) > 0 || m.UpdatePending != "" || m.Action.Kind == ActionFailed || m.Summary.Kind == SummaryAuthFailed || m.Summary.Kind == SummaryDegraded && (m.Summary.Reason.Kind == summary.DegradedMissing || m.Summary.Reason.Kind == summary.DegradedUnsupportedVersion)
}
func (m *Model) acceptSummary(s *summary.SummaryV1) {
	m.usageCache[s.Usage.Range] = &s.Usage
	m.Summary = SummaryState{Kind: SummaryReady, Value: s}
	m.SummaryError = ""
	m.LastSummaryAt = time.Now()
}
func (m *Model) Stop() {
	m.stopped = true
	m.stopMenuBarPolling()
	if m.fetchCancel != nil {
		m.fetchCancel()
	}
	if m.healthCancel != nil {
		m.healthCancel()
	}
	if m.timer != nil {
		m.timer.Stop()
	}
}
