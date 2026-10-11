// Package cli is the real run.Host: the bundled CLI (through the symlink when it exists), launchctl,
// and the local transport. Every CLI child gets `AIO_PROXY_DESKTOP_EXEC=<symlink>`, the only input
// that makes a plist desktop-owned. CLI stdout is never logged: `__desktop-connect` prints the token.
package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/client/health"
	"github.com/aio-proxy/aio-proxy/desktop/internal/client/transport"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/run"
	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
	"github.com/aio-proxy/aio-proxy/desktop/internal/process"
)

const (
	LaunchdLabel = "com.aio-proxy.agent"
	// DiscoveryTimeout: the CLI bounds `__desktop-connect` at 10 s; this only catches a wedged process.
	DiscoveryTimeout = 15 * time.Second
	// ServiceTimeout: `service restart` may wait 10 s for bootout, and `kickstart -k` blocks about 7 s.
	ServiceTimeout = 60 * time.Second
)

// The variables the child environment contract controls; inherited values are dropped.
var controlledEnv = []string{"AIO_PROXY_DESKTOP_EXEC", "AIO_PROXY_HOME", "AIO_PROXY_MANAGED", "XPC_SERVICE_NAME"}

type SystemHost struct {
	// Exec is the symlink when it resolves, else this bundle's sidecar.
	Exec        string
	DesktopExec string
	UID         uint32
}

var _ run.Host = (*SystemHost)(nil)

// NewSystemHost picks the CLI to run; bundle is "" when the app does not run from a bundle. ok is
// false when neither the symlink nor the bundle's sidecar exists.
func NewSystemHost(paths install.Paths, bundle string) (*SystemHost, bool) {
	target := paths.Symlink
	if !exists(target) {
		if bundle == "" {
			return nil, false
		}
		target = install.SidecarOf(bundle)
	}
	if !exists(target) {
		return nil, false
	}
	return &SystemHost{Exec: target, DesktopExec: paths.Symlink, UID: uint32(os.Getuid())}, true
}

// exists follows symlinks, so a dangling symlink does not count.
func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// CLI builds a CLI child with the environment contract. The app never passes its own
// AIO_PROXY_HOME (discovery reads the plist's), and drops the markers that would make `service
// restart` think it runs inside the launchd job. home ("" for none) is the plist's AIO_PROXY_HOME.
func (h *SystemHost) CLI(args []string, home string) *exec.Cmd {
	cmd := exec.Command(h.Exec, args...)
	env := make([]string, 0, len(os.Environ())+2)
	for _, kv := range os.Environ() {
		if !controlled(kv) {
			env = append(env, kv)
		}
	}
	env = append(env, "AIO_PROXY_DESKTOP_EXEC="+h.DesktopExec)
	if home != "" {
		env = append(env, "AIO_PROXY_HOME="+home)
	}
	cmd.Env = env
	return cmd
}

func controlled(kv string) bool {
	name, _, _ := strings.Cut(kv, "=")
	for _, c := range controlledEnv {
		if name == c {
			return true
		}
	}
	return false
}

// check runs cmd and returns its stdout on success. Failures carry stderr's tail, never stdout.
func check(cmd *exec.Cmd, timeout time.Duration, what string) ([]byte, error) {
	out, err := process.RunWithTimeout(cmd, timeout)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", what, err)
	}
	if !out.Success() {
		status := fmt.Sprintf("exit status: %d", out.ExitCode)
		if out.ExitCode < 0 {
			status = "killed by a signal"
		}
		return nil, fmt.Errorf("%s failed (%s): %s", what, status, process.Tail(out.Stderr, 600))
	}
	return out.Stdout, nil
}

func (h *SystemHost) Discover() (discovery.Discovery, error) {
	stdout, err := check(h.CLI([]string{"__desktop-connect"}, ""), DiscoveryTimeout, "__desktop-connect")
	if err != nil {
		return discovery.Discovery{}, err
	}
	return discovery.ParseDiscovery(stdout)
}

func (h *SystemHost) Mutate(mutation policy.Mutation, home string) error {
	switch mutation.Kind {
	case policy.MutationService:
		_, err := check(h.CLI([]string{"service", mutation.Verb}, home), ServiceTimeout, "service "+mutation.Verb)
		return err
	case policy.MutationKickstart:
		cmd := exec.Command("/bin/launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/%s", h.UID, LaunchdLabel))
		_, err := check(cmd, ServiceTimeout, "launchctl kickstart -k")
		return err
	default:
		return fmt.Errorf("unknown mutation %v", mutation)
	}
}

func (h *SystemHost) PidAlive(pid uint32) bool {
	// Signal 0 only checks existence; EPERM means it exists under another user.
	err := syscall.Kill(int(pid), 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func (h *SystemHost) HealthVersion(controlURL string) (string, bool) {
	report, ok := health.Check(context.Background(), controlURL)
	if !ok || report.Version == "" {
		return "", false
	}
	return report.Version, true
}

func (h *SystemHost) Reload(controlURL string) policy.ReloadOutcome {
	url, err := transport.ParseLocalURL(controlURL, "/admin/reload")
	if err != nil {
		return policy.ReloadOutcome{Kind: policy.Failed, Error: err.Error()}
	}
	req := transport.Request{Method: transport.MethodPost, URL: url}
	resp, err := transport.Send(context.Background(), req, transport.DefaultLimits())
	if err != nil {
		return policy.ReloadOutcome{Kind: policy.Failed, Error: err.Error()}
	}
	return policy.ParseReload(resp.Status, resp.Body)
}

func (h *SystemHost) Sleep(d time.Duration) { time.Sleep(d) }

func (h *SystemHost) Now() time.Time { return time.Now() }
