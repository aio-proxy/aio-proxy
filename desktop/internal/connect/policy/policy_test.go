package policy

import (
	"slices"
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery/discoverytest"
)

type doc = discoverytest.Doc

func fixture(t *testing.T, patch func(doc)) *discovery.Discovery {
	t.Helper()
	d := discoverytest.Must(t, patch)
	return &d
}

func auto(t *testing.T, patch func(doc)) (AutoAction, bool) {
	t.Helper()
	return AutomaticAction(fixture(t, patch), true, &AutoAttempts{})
}

func wantAuto(t *testing.T, patch func(doc), want AutoAction) {
	t.Helper()
	if got, ok := auto(t, patch); !ok || got != want {
		t.Errorf("automatic action %v (%v), want %v", got, ok, want)
	}
}

func wantNoAuto(t *testing.T, patch func(doc), why string) {
	t.Helper()
	if got, ok := auto(t, patch); ok {
		t.Errorf("%s: automatic action %v, want none", why, got)
	}
}

func noPlist(v doc) {
	v.Set("unit", map[string]any{"present": false, "wrapperValid": false, "target": nil, "home": nil, "owner": nil})
	v.Set("job", map[string]any{"loaded": false, "disabled": false, "pid": nil})
	v.Set("instance", map[string]any{"controlUrl": "http://127.0.0.1:9317", "reachable": false, "matchesJob": nil})
}

func stoppedProcess(v doc) {
	v.Set("job.pid", nil)
	v.Set("instance.reachable", false)
	v.Set("instance.pid", nil)
	v.Set("instance.matchesJob", nil)
}

func chain(patches ...func(doc)) func(doc) {
	return func(v doc) {
		for _, p := range patches {
			p(v)
		}
	}
}

func set(path string, value any) func(doc) { return func(v doc) { v.Set(path, value) } }

func TestNoPlistInstallsAndStarts(t *testing.T) {
	wantAuto(t, noPlist, AutoInstallAndStart)
}

func TestNoPlistWithAHandStartedInstanceOnThePortIsLeftAlone(t *testing.T) {
	wantNoAuto(t, chain(noPlist, set("instance.reachable", true)), "hand-started instance")
}

func TestAnUninstalledServiceLeftDisabledIsNotReinstalledAutomaticallyButCanBeByTheUser(t *testing.T) {
	d := fixture(t, chain(noPlist, set("job.disabled", true)))
	if _, ok := AutomaticAction(d, true, &AutoAttempts{}); ok {
		t.Error("automatic reinstall")
	}
	if got := OfferedActions(d, true); got != (Offered{Install: true}) {
		t.Errorf("offered %+v", got)
	}
	if got := OfferedActions(d, false); got != (Offered{}) {
		t.Errorf("offered outside a persistent install %+v", got)
	}
	if got, ok := UserMutations(UserInstallAndStart, discovery.OwnerNoPlist); !ok || !slices.Equal(got, AutoMutations(AutoInstallAndStart)) {
		t.Errorf("install mutations %v", got)
	}
	if _, ok := UserMutations(UserInstallAndStart, discovery.OwnerDesktop); ok {
		t.Error("install offered over a desktop plist")
	}
}

func TestAFailedAutomaticInstallCanBeRetriedByAnExplicitClick(t *testing.T) {
	d := fixture(t, noPlist)
	var attempts AutoAttempts
	if got, ok := AutomaticAction(d, true, &attempts); !ok || got != AutoInstallAndStart {
		t.Fatalf("first decision %v %v", got, ok)
	}
	attempts.Mark(AutoInstallAndStart)
	if _, ok := AutomaticAction(d, true, &attempts); ok {
		t.Error("retried automatically")
	}
	if got := OfferedActions(d, true); got != (Offered{Install: true}) {
		t.Errorf("offered %+v", got)
	}
}

func TestAPlistDeletedWhileLoadedOrRunningIsNotInstalledOver(t *testing.T) {
	for _, patch := range []func(doc){set("job.loaded", true), set("job.pid", 4310)} {
		for _, disabled := range []bool{false, true} {
			d := fixture(t, chain(noPlist, patch, set("job.disabled", disabled)))
			if _, ok := AutomaticAction(d, true, &AutoAttempts{}); ok {
				t.Error("automatic install over a live job")
			}
			if OfferedActions(d, true).Install {
				t.Error("install offered over a live job")
			}
		}
	}
}

func TestNothingIsInstalledWhenTheControlAddressWasNotProbed(t *testing.T) {
	patch := chain(noPlist, set("instance.controlUrl", nil))
	for _, p := range []func(doc){patch, chain(patch, set("job.disabled", true))} {
		wantNoAuto(t, p, "unprobed")
		if OfferedActions(fixture(t, p), true).Install {
			t.Error("install offered without a probe")
		}
	}
}

func TestDesktopLoadedEnabledWithoutAProcessIsStarted(t *testing.T) {
	wantAuto(t, stoppedProcess, AutoStartNoProcess)
}

func TestDesktopNotLoadedButEnabledIsStarted(t *testing.T) {
	wantAuto(t, chain(stoppedProcess, set("job.loaded", false)), AutoStartNotLoaded)
}

func TestAUserStoppedDesktopServiceIsNeverStarted(t *testing.T) {
	wantNoAuto(t, chain(stoppedProcess, set("job.loaded", false), set("job.disabled", true)), "disabled")
}

func TestAnOlderRunningDesktopInstanceIsRestarted(t *testing.T) {
	wantAuto(t, nil, AutoRestartForVersion)
}

func TestASameOrNewerRunningInstanceIsNeverDowngraded(t *testing.T) {
	for _, version := range []string{"0.37.0", "0.38.0", "not-a-version"} {
		wantNoAuto(t, set("instance.version", version), version)
	}
}

func TestExternalUnknownAndMismatchedInstancesAreNeverTouched(t *testing.T) {
	for _, owner := range []string{"external", "unknown"} {
		wantNoAuto(t, set("unit.owner", owner), owner)
		wantNoAuto(t, chain(set("unit.owner", owner), stoppedProcess), owner+" stopped")
	}
	wantNoAuto(t, set("instance.matchesJob", false), "mismatched")
	wantNoAuto(t, set("instance.matchesJob", nil), "unknown counts as not matching")
}

func TestNothingIsAutomaticOutsideAPersistentInstall(t *testing.T) {
	for _, patch := range []func(doc){noPlist, stoppedProcess} {
		if _, ok := AutomaticAction(fixture(t, patch), false, &AutoAttempts{}); ok {
			t.Error("automatic outside a persistent install")
		}
	}
}

func TestOneAutomaticMutationPerLaunchBlocksEveryOtherRow(t *testing.T) {
	rows := []*discovery.Discovery{
		fixture(t, noPlist),
		fixture(t, chain(stoppedProcess, set("job.loaded", false))),
		fixture(t, stoppedProcess),
		fixture(t, nil),
	}
	for _, marked := range []AutoAction{AutoInstallAndStart, AutoStartNotLoaded, AutoStartNoProcess, AutoRestartForVersion} {
		var attempts AutoAttempts
		attempts.Mark(marked)
		for _, row := range rows {
			if got, ok := AutomaticAction(row, true, &attempts); ok {
				t.Errorf("after %v: %v", marked, got)
			}
		}
	}
}

func wantMutations(t *testing.T, action UserAction, owner discovery.Owner, want []Mutation) {
	t.Helper()
	got, ok := UserMutations(action, owner)
	if want == nil {
		if ok {
			t.Errorf("%v for %v offered: %v", action, owner, got)
		}
		return
	}
	if !ok || !slices.Equal(got, want) {
		t.Errorf("%v for %v: %v (%v), want %v", action, owner, got, ok, want)
	}
}

func TestRestartUsesKickstartForExternalAndServiceRestartOnlyForDesktop(t *testing.T) {
	wantMutations(t, UserRestart, discovery.OwnerDesktop, []Mutation{Service("restart")})
	wantMutations(t, UserRestart, discovery.OwnerExternal, []Mutation{Kickstart})
	for _, action := range []UserAction{UserStart, UserRestart, UserStop} {
		wantMutations(t, action, discovery.OwnerUnknown, nil)
		wantMutations(t, action, discovery.OwnerNoPlist, nil)
	}
	wantMutations(t, UserStart, discovery.OwnerExternal, []Mutation{Service("start")})
}

func TestAnOrphanedServiceIsOnlyTakenOverOnAClick(t *testing.T) {
	// The brew-uninstalled CLI's plist: KeepAlive keeps relaunching a missing binary.
	orphaned := chain(set("unit.owner", "orphaned"), stoppedProcess)
	wantNoAuto(t, orphaned, "orphaned")
	// Start would only relaunch the missing binary; taking over rewrites the plist to this app.
	if got := OfferedActions(fixture(t, orphaned), true); got != (Offered{TakeOver: true}) {
		t.Errorf("offered %+v", got)
	}
	if got := OfferedActions(fixture(t, orphaned), false); got != (Offered{}) {
		t.Errorf("offered outside a persistent install %+v", got)
	}
	wantMutations(t, UserTakeOver, discovery.OwnerOrphaned, []Mutation{Service("restart")})
	wantMutations(t, UserTakeOver, discovery.OwnerExternal, nil)
	wantMutations(t, UserStart, discovery.OwnerOrphaned, nil)
}

func TestButtonsFollowOwnershipAndRunningState(t *testing.T) {
	cases := []struct {
		name       string
		patch      func(doc)
		persistent bool
		want       Offered
	}{
		{"running", nil, true, Offered{Restart: true, Stop: true, Reload: true}},
		{"stopped", stoppedProcess, true, Offered{Start: true}},
		{"unknown", set("unit.owner", "unknown"), true, Offered{Reload: true}},
		{"read only", nil, false, Offered{Reload: true}},
	}
	for _, c := range cases {
		if got := OfferedActions(fixture(t, c.patch), c.persistent); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestAChangedOwnerMatchOrDisabledFlagInvalidatesTheDecision(t *testing.T) {
	before := fixture(t, nil)
	if !Unchanged(before, fixture(t, set("job.pid", 9999))) {
		t.Error("a new pid invalidated the decision")
	}
	for _, patch := range []func(doc){
		set("unit.owner", "external"),
		set("instance.matchesJob", false),
		set("instance.matchesJob", nil),
		set("job.disabled", true),
	} {
		if Unchanged(before, fixture(t, patch)) {
			t.Error("change not detected")
		}
	}
}

func TestRestartCompletesOnlyAfterTheOldPidIsGoneAndTheVersionMatches(t *testing.T) {
	if RestartComplete(true, new("0.37.0"), new("0.37.0")) {
		t.Error("old sidecar still alive")
	}
	if RestartComplete(false, new("0.36.0"), new("0.37.0")) {
		t.Error("old binary still serving")
	}
	if RestartComplete(false, nil, new("0.37.0")) {
		t.Error("nothing answers yet")
	}
	if !RestartComplete(false, new("0.37.0"), new("0.37.0")) {
		t.Error("expected version answered")
	}
	if !RestartComplete(false, new("0.35.0"), nil) {
		t.Error("external: any version")
	}
}

func TestStopCompletesWhenNoProcessRunsAndNothingAnswers(t *testing.T) {
	if StopComplete(fixture(t, nil)) {
		t.Error("running counted as stopped")
	}
	if !StopComplete(fixture(t, stoppedProcess)) {
		t.Error("stopped not counted")
	}
}

func TestReloadReportsThe409ErrorAndStage(t *testing.T) {
	if got := ParseReload(200, []byte(`{"ok":true,"diff":{}}`)); got != (ReloadOutcome{Kind: Reloaded}) {
		t.Errorf("200: %+v", got)
	}
	got := ParseReload(409, []byte(`{"ok":false,"error":"providers.x: bad key","stage":"validate"}`))
	if want := (ReloadOutcome{Kind: Rejected, Error: "providers.x: bad key", Stage: "validate"}); got != want {
		t.Errorf("409: %+v", got)
	}
	if got := ParseReload(409, []byte(`{"error":7}`)); got != (ReloadOutcome{Kind: Rejected, Error: "config rejected"}) {
		t.Errorf("409 bad body: %+v", got)
	}
	if got := ParseReload(403, []byte("Forbidden")); got.Kind != Failed {
		t.Errorf("403: %+v", got)
	}
}

func TestASpentSlotBlocksEveryAutomaticRow(t *testing.T) {
	var attempts AutoAttempts
	attempts.Spend()
	notLoaded := fixture(t, chain(stoppedProcess, set("job.loaded", false)))
	if got, ok := AutomaticAction(notLoaded, true, &AutoAttempts{}); !ok || got != AutoStartNotLoaded {
		t.Errorf("fresh slot: %v %v", got, ok)
	}
	if _, ok := AutomaticAction(notLoaded, true, &attempts); ok {
		t.Error("a failed Start click is retried")
	}
	if _, ok := AutomaticAction(fixture(t, noPlist), true, &attempts); ok {
		t.Error("install after a spent slot")
	}
}
