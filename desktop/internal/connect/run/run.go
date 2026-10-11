// Package run runs a decided action end to end: fresh discovery, precondition, mutation, completion
// wait. Blocking; the app calls it on a background goroutine. Host is the seam the tests fake.
package run

import (
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
)

const (
	RestartWait = 30 * time.Second
	// StartWait: `service start` returns before the sidecar listens; a start that never answers is a
	// failure.
	StartWait = 30 * time.Second
	StopWait  = 30 * time.Second
	PollEvery = 500 * time.Millisecond
)

type Host interface {
	Discover() (discovery.Discovery, error)
	// Mutate runs one step. home is the plist's AIO_PROXY_HOME ("" for none), so a rewrite keeps the
	// service's own config.
	Mutate(mutation policy.Mutation, home string) error
	PidAlive(pid uint32) bool
	// HealthVersion is `/health`'s version; ok is false when nothing healthy answers.
	HealthVersion(controlURL string) (version string, ok bool)
	Reload(controlURL string) policy.ReloadOutcome
	Sleep(d time.Duration)
	Now() time.Time
}

type ErrorKind int

const (
	// Changed: ownership, `matchesJob` or `job.disabled` changed since the decision; nothing was done.
	Changed ErrorKind = iota
	NotOffered
	// Discovery wraps Err.
	Discovery
	// Command wraps Err.
	Command
	// TimedOut names the action in What.
	TimedOut
)

type RunError struct {
	Kind ErrorKind
	What string
	Err  error
}

// Sentinels for errors.Is, which matches by Kind (and What, when the target sets it).
var (
	ErrChanged    = &RunError{Kind: Changed}
	ErrNotOffered = &RunError{Kind: NotOffered}
)

func (e *RunError) Error() string {
	switch e.Kind {
	case Changed:
		return "the service changed since the panel was shown; nothing was done"
	case NotOffered:
		return "this action is not available for this service"
	case Discovery:
		return "could not inspect the service: " + e.Err.Error()
	case Command:
		return e.Err.Error()
	default:
		return e.What + " did not finish in time"
	}
}

func (e *RunError) Unwrap() error { return e.Err }

func (e *RunError) Is(target error) bool {
	t, ok := target.(*RunError)
	return ok && t.Kind == e.Kind && (t.What == "" || t.What == e.What)
}

type waitKind int

const (
	waitNothing waitKind = iota
	waitStart
	waitRestart
	waitStop
)

type wait struct {
	kind       waitKind
	controlURL string
	oldPid     *uint32
	// expected is nil for an external restart.
	expected *string
}

// RunAuto runs an automatic action on the discovery that decided it. It does not discover again
// first: that discovery is already current, and a second CLI spawn only widens the wait. attempts is
// the launch-wide slot: it is spent before the first mutation runs, so a failure is never retried
// this launch. The caller already decided the install location is persistent.
func RunAuto(host Host, decidedOn *discovery.Discovery, action policy.AutoAction, attempts *policy.AutoAttempts) (discovery.Discovery, error) {
	if attempts.Used(action) {
		return discovery.Discovery{}, ErrNotOffered
	}
	attempts.Mark(action)
	var w wait
	switch action {
	case policy.AutoRestartForVersion:
		w = restartWait(decidedOn, new(decidedOn.BundledVersion))
	default:
		w = startWait(decidedOn)
	}
	return execute(host, decidedOn, policy.AutoMutations(action), w)
}

func RunUser(host Host, rendered *discovery.Discovery, action policy.UserAction) (discovery.Discovery, error) {
	mutations, ok := policy.UserMutations(action, rendered.Unit.Owner)
	if !ok {
		return discovery.Discovery{}, ErrNotOffered
	}
	now, err := fresh(host, rendered)
	if err != nil {
		return discovery.Discovery{}, err
	}
	if action == policy.UserInstallAndStart && !policy.OfferedActions(&now, true).Install {
		return discovery.Discovery{}, ErrChanged
	}
	var w wait
	switch action {
	case policy.UserRestart:
		var expected *string
		if now.Unit.Owner == discovery.OwnerDesktop {
			expected = new(now.BundledVersion)
		}
		w = restartWait(&now, expected)
	case policy.UserTakeOver:
		w = restartWait(&now, new(now.BundledVersion))
	case policy.UserStop:
		w = wait{kind: waitStop}
	case policy.UserInstallAndStart, policy.UserStart:
		w = startWait(&now)
	default:
		w = wait{kind: waitNothing}
	}
	return execute(host, &now, mutations, w)
}

// RunReload: reload is plain HTTP to the instance and carries no ownership precondition.
func RunReload(host Host, rendered *discovery.Discovery) (policy.ReloadOutcome, error) {
	if rendered.Instance.ControlURL == "" {
		return policy.ReloadOutcome{}, ErrNotOffered
	}
	return host.Reload(rendered.Instance.ControlURL), nil
}

func fresh(host Host, decidedOn *discovery.Discovery) (discovery.Discovery, error) {
	now, err := host.Discover()
	if err != nil {
		return discovery.Discovery{}, &RunError{Kind: Discovery, Err: err}
	}
	if !policy.Unchanged(decidedOn, &now) {
		return discovery.Discovery{}, ErrChanged
	}
	return now, nil
}

func startWait(now *discovery.Discovery) wait {
	return wait{kind: waitStart, controlURL: now.Instance.ControlURL}
}

func restartWait(now *discovery.Discovery, expected *string) wait {
	return wait{kind: waitRestart, oldPid: now.Instance.Pid, expected: expected, controlURL: now.Instance.ControlURL}
}

func execute(host Host, now *discovery.Discovery, mutations []policy.Mutation, w wait) (discovery.Discovery, error) {
	for _, mutation := range mutations {
		if err := host.Mutate(mutation, now.Unit.Home); err != nil {
			return discovery.Discovery{}, &RunError{Kind: Command, Err: err}
		}
	}
	var err error
	switch w.kind {
	case waitStart:
		// No control address means nothing can be probed, as for Restart.
		err = poll(host, StartWait, "start", func() bool {
			if w.controlURL == "" {
				return true
			}
			_, ok := host.HealthVersion(w.controlURL)
			return ok
		})
	case waitRestart:
		err = poll(host, RestartWait, "restart", func() bool {
			alive := w.oldPid != nil && host.PidAlive(*w.oldPid)
			var health *string
			if w.controlURL != "" && !alive {
				if version, ok := host.HealthVersion(w.controlURL); ok {
					health = &version
				}
			}
			return policy.RestartComplete(alive, health, w.expected) || (w.controlURL == "" && !alive)
		})
	case waitStop:
		// A transient discovery failure mid-wait means "not done yet", not an abort.
		err = poll(host, StopWait, "stop", func() bool {
			d, err := host.Discover()
			return err == nil && policy.StopComplete(&d)
		})
	}
	if err != nil {
		return discovery.Discovery{}, err
	}
	done, err := host.Discover()
	if err != nil {
		return discovery.Discovery{}, &RunError{Kind: Discovery, Err: err}
	}
	return done, nil
}

func poll(host Host, budget time.Duration, what string, done func() bool) error {
	deadline := host.Now().Add(budget)
	for {
		if done() {
			return nil
		}
		if !host.Now().Before(deadline) {
			return &RunError{Kind: TimedOut, What: what}
		}
		host.Sleep(PollEvery)
	}
}
