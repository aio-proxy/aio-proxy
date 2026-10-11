package process

import (
	"errors"
	"os/exec"
	"testing"
	"time"
)

func TestACommandPastItsTimeoutIsKilled(t *testing.T) {
	started := time.Now()
	_, err := RunWithTimeout(exec.Command("/bin/sh", "-c", "sleep 30"), 200*time.Millisecond)
	if !errors.Is(err, ErrTimedOut) {
		t.Fatalf("err = %v", err)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("waited past the timeout")
	}
}

func TestCapturesStdoutStderrAndStatus(t *testing.T) {
	out, err := RunWithTimeout(exec.Command("/bin/sh", "-c", "printf out; printf err >&2; exit 3"), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if string(out.Stdout) != "out" || Tail(out.Stderr, 10) != "err" || out.ExitCode != 3 {
		t.Fatalf("%+v", out)
	}
}

func TestTailKeepsTheEnd(t *testing.T) {
	if got := Tail([]byte("0123456789"), 3); got != "789" {
		t.Fatal(got)
	}
}
