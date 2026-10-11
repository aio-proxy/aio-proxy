// Package logx is the app's own log: ~/Library/Logs/aio-proxy-desktop/aio-proxy-desktop.log, mirrored
// to stderr. Callers never pass the token, an Authorization header or __desktop-connect stdout.
package logx

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	mu   sync.Mutex
	file *os.File
)

// Init opens the log file. No rotation: one line per event keeps it small.
func Init(dir string) {
	_ = os.MkdirAll(dir, 0o755)
	f, err := os.OpenFile(filepath.Join(dir, "aio-proxy-desktop.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	mu.Lock()
	file = f
	mu.Unlock()
}

func Info(message string) {
	line := fmt.Sprintf("%d %s\n", time.Now().Unix(), message)
	mu.Lock()
	defer mu.Unlock()
	_, _ = os.Stderr.WriteString(line)
	if file != nil {
		_, _ = file.WriteString(line)
	}
}

func Infof(format string, args ...any) { Info(fmt.Sprintf(format, args...)) }
