// Package policy holds the spec's automatic-action and user-action tables, and each action's
// completion condition. Pure: callers pass a discovery and get a decision.
package policy

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
	"github.com/aio-proxy/aio-proxy/desktop/internal/version"
)

type AutoAction int

const (
	// AutoInstallAndStart: no plist: `service install` + `service start`; the app now owns the service.
	AutoInstallAndStart AutoAction = iota
	// AutoStartNotLoaded: desktop, not loaded, enabled.
	AutoStartNotLoaded
	// AutoStartNoProcess: desktop, loaded, enabled, no process: the recovery path.
	AutoStartNoProcess
	// AutoRestartForVersion: desktop, running an older version than the symlink's.
	AutoRestartForVersion
)

// Label is the panel's words for this action.
func (a AutoAction) Label() string {
	switch a {
	case AutoInstallAndStart:
		return "Automatic install and start"
	case AutoStartNotLoaded:
		return "Automatic start"
	case AutoStartNoProcess:
		return "Automatic recovery start"
	case AutoRestartForVersion:
		return "Automatic restart for new version"
	default:
		return fmt.Sprintf("AutoAction(%d)", int(a))
	}
}

func (a AutoAction) String() string { return a.Label() }

// AutoAttempts allows at most ONE automatic mutation per app launch, across all rows: a failed start
// would otherwise be retried through the next row (not loaded -> loaded without a process), and a
// failure shows an error and never loops (a broken config's exit 1 is remapped to 0 and looks
// identical to a clean stop). The zero value has the slot unspent.
type AutoAttempts struct{ spent bool }

// Used is true once any automatic action has run; the argument is kept so callers read per row.
func (a *AutoAttempts) Used(AutoAction) bool { return a.spent }

func (a *AutoAttempts) Mark(AutoAction) { a.Spend() }

// Spend is called for a failed user service action too, so the rediscovery after it never turns
// into an unclicked retry (e.g. an automatic start after a failed Start click).
func (a *AutoAttempts) Spend() { a.spent = true }

// freshInstallPossible: no plist, nothing answering the control address (an empty ControlURL means
// nothing was probed), and no launchd trace of a job (loaded, or running). `job.disabled` is checked
// separately: it is the leftover of a user's `service uninstall`.
func freshInstallPossible(d *discovery.Discovery) bool {
	return d.Unit.Owner == discovery.OwnerNoPlist &&
		!d.Instance.Reachable &&
		d.Instance.ControlURL != "" &&
		!d.Job.Loaded &&
		d.Job.Pid == nil
}

// AutomaticAction decides the launch-time mutation, if any. persistent is the install-location
// check (and no newer copy owning the symlink).
func AutomaticAction(d *discovery.Discovery, persistent bool, attempts *AutoAttempts) (AutoAction, bool) {
	if !persistent {
		return 0, false
	}
	var action AutoAction
	switch d.Unit.Owner {
	case discovery.OwnerNoPlist:
		// A hand-started `aio-proxy run` answering the port is not ours to replace, and a disabled
		// override means the user uninstalled the service: `service start` would re-enable it.
		if !freshInstallPossible(d) || d.Job.Disabled {
			return 0, false
		}
		action = AutoInstallAndStart
	case discovery.OwnerDesktop:
		ours := (d.Instance.MatchesJob != nil && *d.Instance.MatchesJob) || !d.Instance.Reachable
		if !ours || d.Job.Disabled {
			return 0, false
		}
		switch {
		case !d.Job.Loaded:
			action = AutoStartNotLoaded
		case d.Job.Pid == nil:
			action = AutoStartNoProcess
		default:
			if !d.Instance.Reachable || d.Instance.Version == "" {
				return 0, false
			}
			// Never downgrade: only strictly older instances restart; unknown versions do not.
			if cmp, ok := version.Compare(d.Instance.Version, d.BundledVersion); !ok || cmp >= 0 {
				return 0, false
			}
			action = AutoRestartForVersion
		}
	default:
		return 0, false
	}
	if attempts.Used(action) {
		return 0, false
	}
	return action, true
}

type UserAction int

const (
	// UserInstallAndStart installs the plist and starts. An explicit click, so it is offered whenever
	// a fresh install is possible, even when the automatic row is blocked by a leftover
	// `job.disabled` (the user's own `service uninstall`) or an already-spent attempt.
	UserInstallAndStart UserAction = iota
	// UserTakeOver rewrites an orphaned plist to this app's symlink and starts it: `service restart`.
	UserTakeOver
	UserStart
	UserRestart
	UserStop
	UserReload
)

// Label is the panel's words for this action.
func (a UserAction) Label() string {
	switch a {
	case UserInstallAndStart:
		return "Install and start"
	case UserTakeOver:
		return "Take over and start"
	case UserStart:
		return "Start"
	case UserRestart:
		return "Restart"
	case UserStop:
		return "Stop"
	case UserReload:
		return "Reload"
	default:
		return fmt.Sprintf("UserAction(%d)", int(a))
	}
}

func (a UserAction) String() string { return a.Label() }

type Offered struct {
	Install, TakeOver, Start, Restart, Stop, Reload bool
}

// OfferedActions is which buttons the panel shows. Service actions need a persistent install and a
// desktop or external owner; Install needs a persistent install and a fresh-install candidate; Take
// over needs a persistent install and an orphaned plist; Reload only needs a reachable instance.
func OfferedActions(d *discovery.Discovery, persistent bool) Offered {
	owner := d.Unit.Owner
	service := persistent && (owner == discovery.OwnerDesktop || owner == discovery.OwnerExternal)
	running := d.Job.Loaded && d.Job.Pid != nil
	return Offered{
		Install:  persistent && freshInstallPossible(d),
		TakeOver: persistent && owner == discovery.OwnerOrphaned,
		Start:    service && !running,
		Restart:  service && running,
		Stop:     service && running,
		Reload:   d.Instance.Reachable && d.Instance.ControlURL != "",
	}
}

type MutationKind int

const (
	// MutationService is `aio-proxy service <verb>`, always with AIO_PROXY_DESKTOP_EXEC set.
	MutationService MutationKind = iota
	// MutationKickstart is `launchctl kickstart -k gui/<uid>/com.aio-proxy.agent`: restarts an
	// external service without rewriting its plist (`service restart` would rewrite it to the
	// invoking binary).
	MutationKickstart
)

// Mutation is one step the CLI (or launchctl) performs. Comparable with ==.
type Mutation struct {
	Kind MutationKind
	// Verb is the `service` subcommand for MutationService.
	Verb string
}

func Service(verb string) Mutation { return Mutation{Kind: MutationService, Verb: verb} }

var Kickstart = Mutation{Kind: MutationKickstart}

func (m Mutation) String() string {
	if m.Kind == MutationKickstart {
		return "Kickstart"
	}
	return "Service(" + m.Verb + ")"
}

func AutoMutations(action AutoAction) []Mutation {
	switch action {
	case AutoInstallAndStart:
		return []Mutation{Service("install"), Service("start")}
	case AutoStartNotLoaded, AutoStartNoProcess:
		return []Mutation{Service("start")}
	case AutoRestartForVersion:
		return []Mutation{Service("restart")}
	default:
		return nil
	}
}

// UserMutations is the ownership table. ok false means not offered; Reload is HTTP and has no
// mutation.
func UserMutations(action UserAction, owner discovery.Owner) ([]Mutation, bool) {
	desktop, external := owner == discovery.OwnerDesktop, owner == discovery.OwnerExternal
	switch {
	case action == UserInstallAndStart && owner == discovery.OwnerNoPlist:
		return AutoMutations(AutoInstallAndStart), true
	// `service restart` rewrites the plist to the symlink, then reloads it.
	case action == UserTakeOver && owner == discovery.OwnerOrphaned:
		return []Mutation{Service("restart")}, true
	case action == UserStart && (desktop || external):
		return []Mutation{Service("start")}, true
	case action == UserRestart && desktop:
		return []Mutation{Service("restart")}, true
	case action == UserRestart && external:
		return []Mutation{Kickstart}, true
	case action == UserStop && (desktop || external):
		return []Mutation{Service("stop")}, true
	default:
		return nil, false
	}
}

// Unchanged reports whether a fresh discovery agrees with the one a mutation was decided on; a
// mutation proceeds only if it does.
func Unchanged(before, now *discovery.Discovery) bool {
	return before.Unit.Owner == now.Unit.Owner &&
		sameOptBool(before.Instance.MatchesJob, now.Instance.MatchesJob) &&
		before.Job.Disabled == now.Job.Disabled
}

func sameOptBool(a, b *bool) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// RestartComplete: restart is done once the pre-restart sidecar is gone and `/health` answers with
// the expected version (nil for an external service, whose binary version the app does not know).
// healthVersion is nil when nothing answers. This guards the case where the old sidecar outlives
// SIGTERM and keeps serving the old binary.
func RestartComplete(oldPidAlive bool, healthVersion, expected *string) bool {
	if oldPidAlive || healthVersion == nil {
		return false
	}
	if expected == nil {
		return true
	}
	cmp, ok := version.Compare(*healthVersion, *expected)
	return ok && cmp == 0
}

// StopComplete: stop is done once launchd reports no process and nothing answers.
func StopComplete(d *discovery.Discovery) bool {
	return d.Job.Pid == nil && !d.Instance.Reachable
}

type ReloadKind int

const (
	Reloaded ReloadKind = iota
	// Rejected is a 409, which carries `error` and `stage`.
	Rejected
	Failed
)

type ReloadOutcome struct {
	Kind ReloadKind
	// Error is the rejection's `error` (Rejected) or the failure's message (Failed).
	Error string
	// Stage is the rejection's `stage`; "" when absent.
	Stage string
}

func ParseReload(status int, body []byte) ReloadOutcome {
	switch {
	case status >= 200 && status <= 299:
		return ReloadOutcome{Kind: Reloaded}
	case status == 409:
		rejected := ReloadOutcome{Kind: Rejected, Error: "config rejected"}
		// serde's rules: exact keys, and a wrongly typed field rejects the whole body.
		var fields map[string]json.RawMessage
		if json.Unmarshal(body, &fields) != nil {
			return rejected
		}
		errorText, okError := optString(fields["error"])
		stage, okStage := optString(fields["stage"])
		if !okError || !okStage {
			return rejected
		}
		if errorText != nil {
			rejected.Error = *errorText
		}
		if stage != nil {
			rejected.Stage = *stage
		}
		return rejected
	default:
		return ReloadOutcome{Kind: Failed, Error: fmt.Sprintf("reload answered HTTP %d", status)}
	}
}

func optString(raw json.RawMessage) (*string, bool) {
	if raw == nil || bytes.Equal(raw, []byte("null")) {
		return nil, true
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return nil, false
	}
	return &s, true
}
