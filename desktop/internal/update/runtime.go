//go:build !darwin

package update

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"runtime"
	"sync"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/version"
)

// FeedURL is the Linux/Windows update feed. A rehearsal build may replace it with -X.
var FeedURL = "https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/latest.json"

const checkEvery = 6 * time.Hour

type offer struct {
	version, url, signature, asset string
}

var (
	pendingMu sync.Mutex
	pending   *offer
	onOffer   func(string)
	onClear   func()
	// Open shows a release page when the file cannot be replaced.
	Open func(string)
)

func Target() string {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "linux/amd64":
		return "linux-x86_64"
	case "linux/arm64":
		return "linux-aarch64"
	case "windows/amd64":
		return "windows-x86_64"
	default:
		return ""
	}
}

// Start checks at launch and every six hours. It never installs on its own.
func Start(available func(string), clear func()) {
	onOffer, onClear = available, clear
	go func() {
		for {
			check(false)
			time.Sleep(checkEvery)
		}
	}()
}

// CheckNow reports either an update or that this build is current.
func CheckNow(interactive bool) {
	if interactive {
		pendingMu.Lock()
		current := pending
		pendingMu.Unlock()
		if current != nil {
			install(current)
			return
		}
	}
	go check(interactive)
}

func check(interactive bool) {
	target := Target()
	body, err := get(FeedURL)
	if err != nil || target == "" {
		return
	}
	var feed struct {
		Version   string `json:"version"`
		Platforms map[string]struct {
			URL       string `json:"url"`
			Signature string `json:"signature"`
		} `json:"platforms"`
	}
	if json.Unmarshal(body, &feed) != nil {
		return
	}
	entry, ok := feed.Platforms[target]
	asset := path.Base(entry.URL)
	if ok {
		if err := CheckTrusted(entry.Signature, Offer{Version: feed.Version, Target: target, Asset: asset}); err != nil {
			ok = false
		}
	}
	outcome, found := Decide(version.App, feed.Version, ok, interactive)
	switch outcome {
	case CheckAvailable:
		pendingMu.Lock()
		pending = &offer{version: found, url: entry.URL, signature: entry.Signature, asset: asset}
		pendingMu.Unlock()
		if onOffer != nil {
			onOffer(found)
		}
	default:
		pendingMu.Lock()
		had := pending != nil
		pending = nil
		pendingMu.Unlock()
		if had && onClear != nil {
			onClear()
		}
	}
}

func install(current *offer) {
	body, err := get(current.url)
	if err != nil {
		return
	}
	text, err := decodeSignature(current.signature)
	if err != nil || Verify(body, text, PublicKeyB64) != nil || CheckTrusted(current.signature, Offer{Version: current.version, Target: Target(), Asset: current.asset}) != nil {
		return
	}
	action, page := InstallPlan(os.Getenv("APPIMAGE"), writableDir, current.version)
	if action == InstallOpenURL {
		if Open != nil {
			Open(page)
		}
		return
	}
	if err := os.WriteFile(os.Getenv("APPIMAGE"), body, 0o755); err != nil {
		log.Printf("update: %v", err)
	}
}

func writableDir(dir string) bool {
	probe := dir + "/.aio-proxy-update-probe"
	if err := os.WriteFile(probe, nil, 0o600); err != nil {
		return false
	}
	return os.Remove(probe) == nil
}

func decodeSignature(field string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(field)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func get(url string) ([]byte, error) {
	client := &http.Client{Timeout: 2 * time.Minute}
	response, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	return io.ReadAll(io.LimitReader(response.Body, 512<<20))
}
