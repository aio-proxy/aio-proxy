//go:build darwin

package listener

import (
	"bytes"
	"context"
	"net/netip"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func owns(ctx context.Context, local, peer netip.AddrPort, deadline time.Time) bool {
	output, ok := lsof(ctx, local.Port(), deadline)
	return ok && Serves(ParseListeners(output), uint32(os.Getuid()), peer, local)
}

func lsof(ctx context.Context, port uint16, deadline time.Time) (string, bool) {
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/sbin/lsof", "-nP", "-iTCP:"+strconv.Itoa(int(port)), "-Ftun")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.WaitDelay = 100 * time.Millisecond
	err := cmd.Run()
	if ctx.Err() != nil {
		return "", false
	}
	if _, exited := err.(*exec.ExitError); err != nil && !exited {
		return "", false
	}
	return strings.ToValidUTF8(stdout.String(), "\uFFFD"), true
}
