//go:build !darwin

package update

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"runtime"
	"sync"
	"sync/atomic"
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
	pendingMu  sync.Mutex
	checking   sync.Mutex
	installing atomic.Bool
	pending    *offer
	onOffer    func(string)
	onClear    func()
	// OnOutcome is an action-line note. failed is an error; otherwise it is progress or a result.
	// It must not replace a service action that is already running.
	OnOutcome func(note string, failed bool)
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

// CheckNow reports either an update or that this build is current. It never installs.
func CheckNow(interactive bool) { go check(interactive) }

// InstallNow installs the offer a check is holding, after any check already running finishes.
// A second press while one install runs does nothing.
func InstallNow() {
	if !installing.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer installing.Store(false)
		checking.Lock()
		pendingMu.Lock()
		current := pending
		pendingMu.Unlock()
		checking.Unlock()
		if current == nil {
			if onClear != nil {
				onClear()
			}
			return
		}
		if err := install(current); err != nil {
			log.Printf("updater: install failed: %v", err)
			report("Update failed: "+err.Error(), true)
		}
	}()
}

func report(note string, failed bool) {
	if OnOutcome != nil {
		OnOutcome(note, failed)
	}
}

func check(interactive bool) {
	checking.Lock()
	defer checking.Unlock()
	target := Target()
	body, err := get(FeedURL)
	if err != nil {
		log.Printf("updater: check failed: %v", err)
		if interactive {
			report(fmt.Sprintf("Could not check for updates: %v", err), true)
		}
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
		if interactive {
			report("Could not check for updates: the feed was not understood", true)
		}
		return
	}
	entry, ok := feed.Platforms[target]
	asset := ""
	if target != "" && ok {
		asset = path.Base(entry.URL)
		if err := CheckTrusted(entry.Signature, Offer{Version: feed.Version, Target: target, Asset: asset}); err != nil {
			ok = false
		}
	} else {
		ok = false
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
		if outcome == CheckUpToDate {
			report("AIO Proxy is up to date.", false)
		}
	}
}

func install(current *offer) error {
	if runtime.GOOS != "windows" {
		action, page := InstallPlan(os.Getenv("APPIMAGE"), writableDir, current.version)
		if action == InstallOpenURL {
			if Open != nil {
				Open(page)
			}
			return nil
		}
	}
	report("Downloading AIO Proxy "+current.version+"…", false)
	body, err := get(current.url)
	if err != nil {
		return err
	}
	text, err := decodeSignature(current.signature)
	if err != nil {
		return err
	}
	if err := Verify(body, text, PublicKeyB64); err != nil {
		return err
	}
	if err := CheckTrusted(current.signature, Offer{Version: current.version, Target: Target(), Asset: current.asset}); err != nil {
		return err
	}
	return installVerified(current.version, body)
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
