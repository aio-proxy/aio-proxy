package run

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery/discoverytest"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
)

type doc = discoverytest.Doc

type health struct {
	version string
	ok      bool
}

var answers = health{"0.37.0", true}

type call struct {
	mutation policy.Mutation
	home     string
}

// fake is a scripted host: discoveries, liveness and health answers are consumed in order (the last
// one repeats); sleeping advances a fake clock.
type fake struct {
	discoveries   []discovery.Discovery
	alive         []bool
	health        []health
	calls         []call
	clock         time.Time
	failMutations bool
}

func next[T any](queue *[]T) T {
	if len(*queue) == 0 {
		panic("script ran dry")
	}
	head := (*queue)[0]
	if len(*queue) > 1 {
		*queue = (*queue)[1:]
	}
	return head
}

func newFake(discoveries ...discovery.Discovery) *fake {
	return &fake{
		discoveries: discoveries,
		alive:       []bool{false},
		// Something healthy answers unless a test says otherwise, so starts complete at once.
		health: []health{answers},
		clock:  time.Unix(1_700_000_000, 0),
	}
}

func (f *fake) mutations() []policy.Mutation {
	var out []policy.Mutation
	for _, c := range f.calls {
		out = append(out, c.mutation)
	}
	return out
}

func (f *fake) Discover() (discovery.Discovery, error) { return next(&f.discoveries), nil }

func (f *fake) Mutate(mutation policy.Mutation, home string) error {
	f.calls = append(f.calls, call{mutation, home})
	if f.failMutations {
		return errors.New("service start failed (exit 1)")
	}
	return nil
}

func (f *fake) PidAlive(uint32) bool { return next(&f.alive) }

func (f *fake) HealthVersion(string) (string, bool) {
	h := next(&f.health)
	return h.version, h.ok
}

func (f *fake) Reload(string) policy.ReloadOutcome {
	return policy.ReloadOutcome{Kind: policy.Reloaded}
}
func (f *fake) Sleep(d time.Duration) { f.clock = f.clock.Add(d) }
func (f *fake) Now() time.Time        { return f.clock }

func fixture(t *testing.T, patches ...func(doc)) *discovery.Discovery {
	t.Helper()
	d := discoverytest.Must(t, func(v doc) {
		for _, p := range patches {
			p(v)
		}
	})
	return &d
}

func set(path string, value any) func(doc) { return func(v doc) { v.Set(path, value) } }

func stopped(v doc) {
	v.Set("job.pid", nil)
	v.Set("instance.reachable", false)
	v.Set("instance.pid", nil)
	v.Set("instance.matchesJob", nil)
}

func noPlist(v doc) {
	v.Set("unit", map[string]any{"present": false, "owner": nil})
	stopped(v)
	v.Set("job.loaded", false)
}

func wantErr(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("error %v, want %v", err, want)
	}
}

func wantNoMutations(t *testing.T, host *fake) {
	t.Helper()
	if len(host.calls) != 0 {
		t.Errorf("mutations ran: %v", host.mutations())
	}
}

func TestAnAutomaticActionRunsOnItsDecidingDiscoveryWithoutRediscoveringFirst(t *testing.T) {
	// The only scripted discovery is the one after the start. A re-check before mutating would read
	// it as "an instance appeared" and abort the install.
	host := newFake(*fixture(t))
	after, err := RunAuto(host, fixture(t, noPlist), policy.AutoInstallAndStart, &policy.AutoAttempts{})
	if err != nil {
		t.Fatal(err)
	}
	if !after.Instance.Reachable {
		t.Fatal("completion discovery was not the one after start")
	}
	if got := host.mutations(); !slices.Equal(got, []policy.Mutation{policy.Service("install"), policy.Service("start")}) {
		t.Errorf("mutations %v", got)
	}
}

func TestAClickIsRefusedWhenTheServiceChangedOwner(t *testing.T) {
	host := newFake(*fixture(t, set("unit.owner", "external")))
	_, err := RunUser(host, fixture(t), policy.UserStop)
	wantErr(t, err, ErrChanged)
	wantNoMutations(t, host)
}

func TestInstallAndStartRunInOrder(t *testing.T) {
	host := newFake(*fixture(t, noPlist))
	if _, err := RunAuto(host, fixture(t, noPlist), policy.AutoInstallAndStart, &policy.AutoAttempts{}); err != nil {
		t.Fatal(err)
	}
	if got := host.mutations(); !slices.Equal(got, []policy.Mutation{policy.Service("install"), policy.Service("start")}) {
		t.Errorf("mutations %v", got)
	}
	if host.calls[0].home != "" {
		t.Errorf("a fresh install uses the default home, got %q", host.calls[0].home)
	}
}

func TestServiceCommandsCarryThePlistHome(t *testing.T) {
	host := newFake(*fixture(t, stopped))
	if _, err := RunUser(host, fixture(t, stopped), policy.UserStart); err != nil {
		t.Fatal(err)
	}
	if want := (call{policy.Service("start"), "/Users/me/.aio-proxy"}); host.calls[0] != want {
		t.Errorf("call %+v", host.calls[0])
	}
}

func TestAnExternalRestartKickstartsAndNeverRewritesThePlist(t *testing.T) {
	external := set("unit.owner", "external")
	host := newFake(*fixture(t, external))
	host.health = []health{{"0.20.0", true}}
	if _, err := RunUser(host, fixture(t, external), policy.UserRestart); err != nil {
		t.Fatal(err)
	}
	if got := host.mutations(); !slices.Equal(got, []policy.Mutation{policy.Kickstart}) {
		t.Errorf("mutations %v", got)
	}
}

func TestRestartWaitsForTheOldSidecarToDieAndTheNewVersionToAnswer(t *testing.T) {
	host := newFake(*fixture(t))
	host.alive = []bool{true, true, false}
	host.health = []health{{"0.36.0", true}, answers}
	started := host.Now()
	if _, err := RunAuto(host, fixture(t), policy.AutoRestartForVersion, &policy.AutoAttempts{}); err != nil {
		t.Fatal(err)
	}
	if got := host.mutations(); !slices.Equal(got, []policy.Mutation{policy.Service("restart")}) {
		t.Errorf("mutations %v", got)
	}
	if waited := host.Now().Sub(started); waited != PollEvery*3 {
		t.Errorf("waited %v: two polls with the old pid alive, one on the old version", waited)
	}
}

func TestRestartTimesOutWhenTheOldSidecarNeverExits(t *testing.T) {
	host := newFake(*fixture(t))
	host.alive = []bool{true}
	started := host.Now()
	_, err := RunUser(host, fixture(t), policy.UserRestart)
	wantErr(t, err, &RunError{Kind: TimedOut, What: "restart"})
	if err.Error() != "restart did not finish in time" {
		t.Errorf("message %q", err)
	}
	if waited := host.Now().Sub(started); waited < RestartWait || waited > RestartWait+PollEvery {
		t.Errorf("waited %v", waited)
	}
}

func TestStopWaitsForNoProcessAndNoAnswer(t *testing.T) {
	host := newFake(*fixture(t), *fixture(t), *fixture(t, stopped))
	done, err := RunUser(host, fixture(t), policy.UserStop)
	if err != nil {
		t.Fatal(err)
	}
	if got := host.mutations(); !slices.Equal(got, []policy.Mutation{policy.Service("stop")}) {
		t.Errorf("mutations %v", got)
	}
	if !policy.StopComplete(&done) {
		t.Error("returned discovery is not stopped")
	}
}

func TestUnknownOwnersGetNoServiceAction(t *testing.T) {
	unknown := fixture(t, set("unit.owner", "unknown"))
	host := newFake(*unknown)
	_, err := RunUser(host, unknown, policy.UserRestart)
	wantErr(t, err, ErrNotOffered)
	outcome, err := RunReload(host, unknown)
	if err != nil || outcome.Kind != policy.Reloaded {
		t.Errorf("reload %+v %v", outcome, err)
	}
}

func TestAFailedAutomaticMutationSpendsTheAttemptSoItIsNeverRetried(t *testing.T) {
	host := newFake(*fixture(t, stopped))
	host.failMutations = true
	var attempts policy.AutoAttempts
	_, err := RunAuto(host, fixture(t, stopped), policy.AutoStartNoProcess, &attempts)
	wantErr(t, err, &RunError{Kind: Command})
	if err.Error() != "service start failed (exit 1)" {
		t.Errorf("message %q", err)
	}
	if !attempts.Used(policy.AutoStartNotLoaded) {
		t.Error("the slot is shared across rows")
	}
	_, again := RunAuto(host, fixture(t, stopped), policy.AutoStartNoProcess, &attempts)
	wantErr(t, again, ErrNotOffered)
	if len(host.calls) != 1 {
		t.Errorf("mutations %v", host.mutations())
	}
}

func TestAnExplicitInstallClickInstallsThenStarts(t *testing.T) {
	host := newFake(*fixture(t, noPlist))
	if _, err := RunUser(host, fixture(t, noPlist), policy.UserInstallAndStart); err != nil {
		t.Fatal(err)
	}
	if got := host.mutations(); !slices.Equal(got, []policy.Mutation{policy.Service("install"), policy.Service("start")}) {
		t.Errorf("mutations %v", got)
	}
}

func TestAnInstallClickIsRefusedWhenTheServiceIsNotAFreshInstall(t *testing.T) {
	for _, owner := range []string{"external", "unknown"} {
		existing := fixture(t, set("unit.owner", owner))
		host := newFake(*existing)
		_, err := RunUser(host, existing, policy.UserInstallAndStart)
		wantErr(t, err, ErrNotOffered)
		wantNoMutations(t, host)
	}
}

func TestAnInstallClickIsRefusedWhenAnInstanceStartedMeanwhile(t *testing.T) {
	host := newFake(*fixture(t, noPlist, set("instance.reachable", true)))
	_, err := RunUser(host, fixture(t, noPlist), policy.UserInstallAndStart)
	wantErr(t, err, ErrChanged)
	wantNoMutations(t, host)
}

func TestAStartWaitsForHealthAndFailsWhenTheProxyNeverAnswers(t *testing.T) {
	host := newFake(*fixture(t, stopped))
	host.health = []health{{}, {}, answers}
	started := host.Now()
	if _, err := RunUser(host, fixture(t, stopped), policy.UserStart); err != nil {
		t.Fatal(err)
	}
	if waited := host.Now().Sub(started); waited != PollEvery*2 {
		t.Errorf("waited %v: two polls before /health answered", waited)
	}

	host.health = []health{{}}
	started = host.Now()
	_, err := RunAuto(host, fixture(t, stopped), policy.AutoStartNoProcess, &policy.AutoAttempts{})
	wantErr(t, err, &RunError{Kind: TimedOut, What: "start"})
	if waited := host.Now().Sub(started); waited < StartWait || waited > StartWait+PollEvery {
		t.Errorf("waited %v", waited)
	}
}

func TestADiscoveryFailureNamesItsCause(t *testing.T) {
	err := &RunError{Kind: Discovery, Err: errors.New("__desktop-connect: timed out")}
	if err.Error() != "could not inspect the service: __desktop-connect: timed out" {
		t.Errorf("message %q", err)
	}
}
