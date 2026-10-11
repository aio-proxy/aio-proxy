// Package discovery parses the one JSON object `aio-proxy __desktop-connect` prints on stdout
// (packages/cli/src/desktop-connect/desktop-connect.ts). Every ambiguity fails closed: a field the
// app cannot read never permits more automation than an explicit value would.
package discovery

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/aio-proxy/aio-proxy/desktop/internal/token"
)

type Owner int

const (
	// OwnerUnknown is an unrecognized wrapper, or anything the app cannot read. The zero value, so
	// an unset owner fails closed.
	OwnerUnknown Owner = iota
	// OwnerDesktop: the plist's wrapper target is this app's symlink.
	OwnerDesktop
	// OwnerExternal: a valid wrapper pointing anywhere else (a CLI install).
	OwnerExternal
	// OwnerOrphaned: an external wrapper whose target is gone: the CLI was uninstalled and left its
	// plist, so launchd can only fail to start it. Offered for takeover on a click.
	OwnerOrphaned
	// OwnerNoPlist: `owner: null` with `present: false`: no plist, so a fresh install is allowed.
	OwnerNoPlist
)

func (o Owner) String() string {
	switch o {
	case OwnerDesktop:
		return "Desktop"
	case OwnerExternal:
		return "External"
	case OwnerOrphaned:
		return "Orphaned"
	case OwnerNoPlist:
		return "NoPlist"
	default:
		return "Unknown"
	}
}

type Unit struct {
	Present      bool
	WrapperValid bool
	Target       string
	// Home is the plist's AIO_PROXY_HOME; "" when unset.
	Home  string
	Owner Owner
}

type Job struct {
	Loaded bool
	// A missing value reads as disabled: the app must never `enable` a job the user stopped.
	Disabled bool
	Pid      *uint32
}

type Instance struct {
	// ControlURL is "" when nothing was probed (`controlUrl: null`).
	ControlURL   string
	DashboardURL string
	Reachable    bool
	Version      string
	Pid          *uint32
	Ppid         *uint32
	// MatchesJob nil (unknown) counts as not matching for automation.
	MatchesJob *bool
}

type Discovery struct {
	BundledVersion string
	Unit           Unit
	Job            Job
	Instance       Instance
	Token          *token.Token
}

// ParseDiscovery parses `__desktop-connect` stdout. Errors name only the error category (as serde's
// classify does): a data error's message can quote a value, and stdout carries the token.
func ParseDiscovery(stdout []byte) (Discovery, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(stdout), &top); err != nil {
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) {
			// Valid JSON that is not an object has no protocolVersion.
			return Discovery{}, errors.New("unsupported __desktop-connect protocolVersion None")
		}
		return Discovery{}, fmt.Errorf("__desktop-connect printed invalid JSON (%s)", classify(err))
	}
	if version, ok := top["protocolVersion"]; !ok || !bytes.Equal(version, []byte("1")) {
		shown := "None"
		var n json.Number
		if ok && json.Unmarshal(version, &n) == nil && isUint(n) {
			shown = "Some(" + n.String() + ")"
		}
		return Discovery{}, fmt.Errorf("unsupported __desktop-connect protocolVersion %s", shown)
	}
	d, err := decode(top)
	if err != nil {
		return Discovery{}, errors.New("__desktop-connect printed an unexpected shape (Data)")
	}
	return d, nil
}

func classify(err error) string {
	var syntax *json.SyntaxError
	if errors.As(err, &syntax) && syntax.Error() == "unexpected end of JSON input" {
		return "Eof"
	}
	return "Syntax"
}

func isUint(n json.Number) bool {
	for _, c := range n.String() {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func decode(top fields) (Discovery, error) {
	var d Discovery
	var err error
	if d.BundledVersion, err = top.requiredString("bundledVersion"); err != nil {
		return d, err
	}
	unit, err := top.object("unit")
	if err != nil {
		return d, err
	}
	if d.Unit, err = decodeUnit(unit); err != nil {
		return d, err
	}
	job, err := top.object("job")
	if err != nil {
		return d, err
	}
	if d.Job, err = decodeJob(job); err != nil {
		return d, err
	}
	instance, err := top.object("instance")
	if err != nil {
		return d, err
	}
	if d.Instance, err = decodeInstance(instance); err != nil {
		return d, err
	}
	if raw, ok := top["token"]; ok && !isNull(raw) {
		var t token.Token
		if err := json.Unmarshal(raw, &t); err != nil {
			return d, err
		}
		d.Token = &t
	}
	return d, nil
}

func decodeUnit(f fields) (Unit, error) {
	var u Unit
	var err error
	if u.Present, err = f.bool("present", true); err != nil {
		return u, err
	}
	if u.WrapperValid, err = f.bool("wrapperValid", false); err != nil {
		return u, err
	}
	if u.Target, err = f.optString("target"); err != nil {
		return u, err
	}
	if u.Home, err = f.optString("home"); err != nil {
		return u, err
	}
	u.Owner = owner(f)
	if u.Owner == OwnerNoPlist && u.Present {
		u.Owner = OwnerUnknown
	}
	return u, nil
}

func owner(f fields) Owner {
	raw, ok := f["owner"]
	if !ok {
		return OwnerUnknown
	}
	if isNull(raw) {
		return OwnerNoPlist
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return OwnerUnknown
	}
	switch s {
	case "desktop":
		return OwnerDesktop
	case "external":
		return OwnerExternal
	case "orphaned":
		return OwnerOrphaned
	default:
		return OwnerUnknown
	}
}

func decodeJob(f fields) (Job, error) {
	var j Job
	var err error
	if j.Loaded, err = f.bool("loaded", false); err != nil {
		return j, err
	}
	if j.Disabled, err = f.bool("disabled", true); err != nil {
		return j, err
	}
	j.Pid, err = f.optUint32("pid")
	return j, err
}

func decodeInstance(f fields) (Instance, error) {
	var i Instance
	var err error
	if i.ControlURL, err = f.optString("controlUrl"); err != nil {
		return i, err
	}
	if i.DashboardURL, err = f.optString("dashboardUrl"); err != nil {
		return i, err
	}
	if i.Reachable, err = f.bool("reachable", false); err != nil {
		return i, err
	}
	if i.Version, err = f.optString("version"); err != nil {
		return i, err
	}
	if i.Pid, err = f.optUint32("pid"); err != nil {
		return i, err
	}
	if i.Ppid, err = f.optUint32("ppid"); err != nil {
		return i, err
	}
	if raw, ok := f["matchesJob"]; ok && !isNull(raw) {
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return i, err
		}
		i.MatchesJob = &b
	}
	return i, nil
}

// fields decodes with serde's rules rather than encoding/json's: keys match exactly, a missing
// field takes its default, and null is accepted only where the Rust type was an Option.
type fields map[string]json.RawMessage

var errShape = errors.New("unexpected shape")

func isNull(raw json.RawMessage) bool { return bytes.Equal(raw, []byte("null")) }

func (f fields) object(name string) (fields, error) {
	raw, ok := f[name]
	if !ok || isNull(raw) {
		return nil, errShape
	}
	var out fields
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (f fields) requiredString(name string) (string, error) {
	raw, ok := f[name]
	if !ok || isNull(raw) {
		return "", errShape
	}
	var s string
	err := json.Unmarshal(raw, &s)
	return s, err
}

func (f fields) bool(name string, missing bool) (bool, error) {
	raw, ok := f[name]
	if !ok {
		return missing, nil
	}
	if isNull(raw) {
		return false, errShape
	}
	var b bool
	err := json.Unmarshal(raw, &b)
	return b, err
}

func (f fields) optString(name string) (string, error) {
	raw, ok := f[name]
	if !ok || isNull(raw) {
		return "", nil
	}
	var s string
	err := json.Unmarshal(raw, &s)
	return s, err
}

func (f fields) optUint32(name string) (*uint32, error) {
	raw, ok := f[name]
	if !ok || isNull(raw) {
		return nil, nil
	}
	var n uint32
	if err := json.Unmarshal(raw, &n); err != nil {
		return nil, err
	}
	return &n, nil
}
