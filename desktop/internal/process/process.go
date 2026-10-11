// Package process runs helper processes with a hard timeout. Output is returned, never logged:
// __desktop-connect stdout carries the token.
package process

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// ErrTimedOut wraps every timeout error, for errors.Is.
var ErrTimedOut = errors.New("timed out")

type Output struct {
	Stdout, Stderr []byte
	// ExitCode is -1 when the process was killed by a signal.
	ExitCode int
}

func (o Output) Success() bool { return o.ExitCode == 0 }

// RunWithTimeout runs cmd with stdin closed and SIGKILLs it past timeout. A nonzero exit is not an
// error: callers read Output.ExitCode.
func RunWithTimeout(cmd *exec.Cmd, timeout time.Duration) (Output, error) {
	var stdout, stderr bytes.Buffer
	cmd.Stdin = nil
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		return Output{}, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		out := Output{Stdout: stdout.Bytes(), Stderr: stderr.Bytes(), ExitCode: cmd.ProcessState.ExitCode()}
		var exit *exec.ExitError
		if err != nil && !errors.As(err, &exit) {
			return out, err
		}
		return out, nil
	case <-time.After(timeout):
		// The waiter goroutine still reaps it. Not waiting here: a grandchild holding the pipes open
		// would block past the timeout.
		killProcess(cmd.Process)
		return Output{}, fmt.Errorf("%w after %s", ErrTimedOut, timeout)
	}
}

// Tail is the last max bytes of a stream, for error messages built from stderr.
func Tail(b []byte, max int) string {
	if len(b) > max {
		b = b[len(b)-max:]
	}
	return strings.TrimSpace(strings.ToValidUTF8(string(b), "\uFFFD"))
}
