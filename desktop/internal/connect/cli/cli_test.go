package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery/discoverytest"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
)

const symlink = "/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy"

func host(exec string) *SystemHost {
	return &SystemHost{Exec: exec, DesktopExec: symlink, UID: 501}
}

// envOf is the value cmd sets for name; ok is false when the variable is absent.
func envOf(cmd *exec.Cmd, name string) (value string, ok bool) {
	for _, kv := range cmd.Env {
		if k, v, _ := strings.Cut(kv, "="); k == name {
			value, ok = v, true
		}
	}
	return value, ok
}

func TestEveryCLIChildGetsTheSymlinkMarkerAndNoInheritedHome(t *testing.T) {
	t.Setenv("AIO_PROXY_HOME", "/Users/me/.aio-proxy-mine")
	t.Setenv("AIO_PROXY_MANAGED", "1")
	t.Setenv("XPC_SERVICE_NAME", "com.aio-proxy.agent")
	t.Setenv("AIO_PROXY_DESKTOP_EXEC", "/elsewhere")
	t.Setenv("AIO_PROXY_KEEP", "kept")
	cmd := host("/bin/sh").CLI([]string{"__desktop-connect"}, "")
	if v, ok := envOf(cmd, "AIO_PROXY_DESKTOP_EXEC"); !ok || v != symlink {
		t.Errorf("AIO_PROXY_DESKTOP_EXEC %q %v", v, ok)
	}
	for _, name := range []string{"AIO_PROXY_HOME", "AIO_PROXY_MANAGED", "XPC_SERVICE_NAME"} {
		if v, ok := envOf(cmd, name); ok {
			t.Errorf("%s inherited: %q", name, v)
		}
	}
	if v, _ := envOf(cmd, "AIO_PROXY_KEEP"); v != "kept" {
		t.Error("unrelated environment dropped")
	}
	if n := strings.Count(strings.Join(cmd.Env, "\n"), "AIO_PROXY_DESKTOP_EXEC="); n != 1 {
		t.Errorf("AIO_PROXY_DESKTOP_EXEC set %d times", n)
	}
}

func TestAServiceCommandCarriesThePlistHome(t *testing.T) {
	t.Setenv("AIO_PROXY_HOME", "/Users/me/.aio-proxy-mine")
	cmd := host("/bin/sh").CLI([]string{"service", "restart"}, "/Users/me/.aio-proxy-work")
	if v, ok := envOf(cmd, "AIO_PROXY_HOME"); !ok || v != "/Users/me/.aio-proxy-work" {
		t.Errorf("AIO_PROXY_HOME %q %v", v, ok)
	}
}

func writeScript(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func skipUnixShell(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("runs a Unix shell script")
	}
}

func TestDiscoveryReadsTheChildsStdoutAndReportsFailuresWithoutIt(t *testing.T) {
	skipUnixShell(t)
	script := filepath.Join(t.TempDir(), "aio-proxy")
	writeScript(t, script, "#!/bin/sh\n[ \"$1\" = __desktop-connect ] || exit 9\ncat <<'JSON'\n"+discoverytest.SpecExample+"JSON\n")
	found, err := host(script).Discover()
	if err != nil {
		t.Fatal(err)
	}
	if found.BundledVersion != "0.37.0" {
		t.Errorf("bundled version %q", found.BundledVersion)
	}

	writeScript(t, script, "#!/bin/sh\necho '{\"token\":\"tok-leak\"}'\necho boom >&2\nexit 2\n")
	_, err = host(script).Discover()
	if err == nil || !strings.Contains(err.Error(), "boom") || strings.Contains(err.Error(), "tok-leak") {
		t.Errorf("error %v", err)
	}
}

func TestAFailingDiscoveryIsAnErrorEvenWhenStdoutIsValidJSON(t *testing.T) {
	skipUnixShell(t)
	script := filepath.Join(t.TempDir(), "aio-proxy")
	writeScript(t, script, "#!/bin/sh\ncat <<'JSON'\n"+discoverytest.SpecExample+"JSON\necho boom >&2\nexit 1\n")
	_, err := host(script).Discover()
	if err == nil || !strings.Contains(err.Error(), "boom") || strings.Contains(err.Error(), "tok-abc") {
		t.Errorf("error %v", err)
	}
}

func TestServiceVerbsRunTheCLIWithThePlistHome(t *testing.T) {
	skipUnixShell(t)
	dir := t.TempDir()
	script, record := filepath.Join(dir, "aio-proxy"), filepath.Join(dir, "record")
	writeScript(t, script, "#!/bin/sh\necho \"$1 $2 $AIO_PROXY_HOME $AIO_PROXY_DESKTOP_EXEC\" > '"+record+"'\n")
	if err := host(script).Mutate(policy.Service("start"), "/Users/me/.aio-proxy-work"); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(record)
	if want := "service start /Users/me/.aio-proxy-work " + symlink + "\n"; string(got) != want {
		t.Errorf("recorded %q, want %q", got, want)
	}

	writeScript(t, script, "#!/bin/sh\necho 'not loaded' >&2\nexit 3\n")
	err := host(script).Mutate(policy.Service("stop"), "")
	if err == nil || err.Error() != "service stop failed (exit status: 3): not loaded" {
		t.Errorf("error %v", err)
	}
}

func TestPidAliveCountsOnlyExistingProcesses(t *testing.T) {
	skipUnixShell(t)
	h := host("/bin/sh")
	if !h.PidAlive(uint32(os.Getpid())) {
		t.Error("this process reads as dead")
	}
	if !h.PidAlive(1) {
		t.Error("launchd (another user: EPERM) reads as dead")
	}
	cmd := exec.Command("/bin/sh", "-c", "exit 0")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if h.PidAlive(uint32(cmd.Process.Pid)) {
		t.Error("a reaped child reads as alive")
	}
}

func TestBundledSidecarUsesThePlatformLayout(t *testing.T) {
	switch runtime.GOOS {
	case "darwin":
		bundle := filepath.Join("/Applications", "AIO Proxy.app")
		if got := bundledSidecar("darwin", bundle, ""); got != install.SidecarOf(bundle) {
			t.Fatalf("darwin %s", got)
		}
	case "windows":
		bundle := filepath.Join(`C:\AIO Proxy`, "aio-proxy-desktop.exe")
		if got, want := bundledSidecar("windows", bundle, ""), filepath.Join(`C:\AIO Proxy`, "aio-proxy.exe"); got != want {
			t.Fatalf("windows %s", got)
		}
	default:
		if got := bundledSidecar("linux", "/opt/aio-proxy-desktop", ""); got != "/opt/aio-proxy" {
			t.Fatalf("linux beside the host %s", got)
		}
		if got := bundledSidecar("linux", "/opt/aio-proxy-desktop", "relative"); got != "/opt/aio-proxy" {
			t.Fatalf("relative APPDIR %s", got)
		}
		if got := bundledSidecar("linux", "/opt/AIO.AppImage", "/tmp/mount"); got != "/tmp/mount/usr/bin/aio-proxy" {
			t.Fatalf("APPDIR %s", got)
		}
	}
}

func TestNewSystemHostPrefersTheSymlinkThenTheBundledSidecar(t *testing.T) {
	t.Setenv("APPDIR", "")
	dir := t.TempDir()
	paths := install.Paths{Symlink: filepath.Join(dir, "bin", "aio-proxy")}
	bundle := filepath.Join(dir, "AIO Proxy.app")
	sidecar := install.SidecarOf(bundle)
	if runtime.GOOS != "darwin" {
		bundle = filepath.Join(dir, "aio-proxy-desktop")
		sidecar = filepath.Join(dir, "aio-proxy")
		if runtime.GOOS == "windows" {
			bundle += ".exe"
			sidecar += ".exe"
		}
	}
	if _, ok := NewSystemHost(paths, ""); ok {
		t.Error("a host without any CLI")
	}
	if _, ok := NewSystemHost(paths, bundle); ok {
		t.Error("a host with a missing sidecar")
	}
	if err := os.MkdirAll(filepath.Dir(sidecar), 0o755); err != nil {
		t.Fatal(err)
	}
	writeScript(t, sidecar, "#!/bin/sh\n")
	h, ok := NewSystemHost(paths, bundle)
	if !ok || h.Exec != sidecar || h.DesktopExec != paths.Symlink || h.UID != currentUID() {
		t.Errorf("sidecar host %+v %v", h, ok)
	}
	if err := os.MkdirAll(filepath.Dir(paths.Symlink), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sidecar, paths.Symlink); err != nil {
		t.Fatal(err)
	}
	if h, ok := NewSystemHost(paths, bundle); !ok || h.Exec != paths.Symlink {
		t.Errorf("symlink host %+v %v", h, ok)
	}
}
