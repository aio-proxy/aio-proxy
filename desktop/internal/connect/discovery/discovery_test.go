package discovery_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery/discoverytest"
)

type doc = discoverytest.Doc

func with(t *testing.T, patch func(doc)) discovery.Discovery {
	t.Helper()
	return discoverytest.Must(t, patch)
}

func TestParsesTheSpecExample(t *testing.T) {
	d, err := discovery.ParseDiscovery([]byte(discoverytest.SpecExample))
	if err != nil {
		t.Fatal(err)
	}
	if d.BundledVersion != "0.37.0" {
		t.Errorf("bundled version %q", d.BundledVersion)
	}
	if d.Unit.Owner != discovery.OwnerDesktop {
		t.Errorf("owner %v", d.Unit.Owner)
	}
	if d.Unit.Home != "/Users/me/.aio-proxy" {
		t.Errorf("home %q", d.Unit.Home)
	}
	if d.Job.Pid == nil || *d.Job.Pid != 4310 {
		t.Errorf("job pid %v", d.Job.Pid)
	}
	if d.Job.Disabled {
		t.Error("disabled")
	}
	if d.Instance.MatchesJob == nil || !*d.Instance.MatchesJob {
		t.Errorf("matchesJob %v", d.Instance.MatchesJob)
	}
	if d.Token == nil || d.Token.Expose() != "tok-abc" {
		t.Errorf("token %v", d.Token)
	}
}

func TestOwnerNullWithoutAPlistIsTheOnlyFreshInstallSignal(t *testing.T) {
	d := with(t, func(v doc) {
		v.Set("unit", map[string]any{"present": false, "wrapperValid": false, "target": nil, "home": nil, "owner": nil})
	})
	if d.Unit.Owner != discovery.OwnerNoPlist {
		t.Errorf("owner %v", d.Unit.Owner)
	}
}

func TestEveryOtherOwnerShapeFailsClosedToUnknown(t *testing.T) {
	cases := []struct {
		name  string
		patch func(doc)
		want  discovery.Owner
	}{
		{"null but present", func(v doc) { v.Set("unit.owner", nil) }, discovery.OwnerUnknown},
		{"missing", func(v doc) { v.Delete("unit.owner") }, discovery.OwnerUnknown},
		{"future", func(v doc) { v.Set("unit.owner", "desktop-v2") }, discovery.OwnerUnknown},
		{"not a string", func(v doc) { v.Set("unit.owner", 7) }, discovery.OwnerUnknown},
		{"external", func(v doc) { v.Set("unit.owner", "external") }, discovery.OwnerExternal},
		{"orphaned", func(v doc) { v.Set("unit.owner", "orphaned") }, discovery.OwnerOrphaned},
	}
	for _, c := range cases {
		if got := with(t, c.patch).Unit.Owner; got != c.want {
			t.Errorf("%s: owner %v, want %v", c.name, got, c.want)
		}
	}
}

func TestAMissingDisabledFlagReadsAsDisabled(t *testing.T) {
	if !with(t, func(v doc) { v.Delete("job.disabled") }).Job.Disabled {
		t.Error("missing disabled read as enabled")
	}
}

func TestMatchesJobNullStaysUnknown(t *testing.T) {
	if m := with(t, func(v doc) { v.Set("instance.matchesJob", nil) }).Instance.MatchesJob; m != nil {
		t.Errorf("matchesJob %v", *m)
	}
}

func TestNullIsOnlyAcceptedForOptionalFields(t *testing.T) {
	for _, path := range []string{"job.disabled", "unit.present", "instance.reachable", "bundledVersion", "job"} {
		if _, err := discoverytest.With(func(v doc) { v.Set(path, nil) }); err == nil {
			t.Errorf("%s: null accepted", path)
		}
	}
	if _, err := discoverytest.With(func(v doc) { v.Delete("instance") }); err == nil {
		t.Error("missing instance accepted")
	}
}

func TestRejectsAnotherProtocolVersionAndNonJSON(t *testing.T) {
	for _, version := range []any{2, 1.5, "1", nil} {
		if _, err := discoverytest.With(func(v doc) { v.Set("protocolVersion", version) }); err == nil {
			t.Errorf("protocolVersion %v accepted", version)
		}
	}
	for _, input := range []string{"", "Unexpected internal error", discoverytest.SpecExample + "\n{}", "[1]"} {
		if _, err := discovery.ParseDiscovery([]byte(input)); err == nil {
			t.Errorf("%q accepted", input)
		}
	}
}

func TestNeitherErrorsNorDebugOutputLeakTheToken(t *testing.T) {
	d, err := discovery.ParseDiscovery([]byte(discoverytest.SpecExample))
	if err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"%v", "%+v", "%#v"} {
		if s := fmt.Sprintf(format, d); strings.Contains(s, "tok-abc") {
			t.Errorf("%s leaks: %s", format, s)
		}
		if s := fmt.Sprintf(format, *d.Token); strings.Contains(s, "tok-abc") {
			t.Errorf("%s token leaks: %s", format, s)
		}
	}
	broken := strings.Replace(discoverytest.SpecExample, `"bundledVersion": "0.37.0"`, `"bundledVersion": 7`, 1)
	if _, err := discovery.ParseDiscovery([]byte(broken)); err == nil || strings.Contains(err.Error(), "tok-abc") {
		t.Errorf("error %v", err)
	}
	badToken := strings.Replace(discoverytest.SpecExample, `"token": "tok-abc"`, `"token": ["tok-abc"]`, 1)
	if _, err := discovery.ParseDiscovery([]byte(badToken)); err == nil || strings.Contains(err.Error(), "tok-abc") {
		t.Errorf("error %v", err)
	}
}
