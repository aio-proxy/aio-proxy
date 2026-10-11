// Package discoverytest holds a `__desktop-connect` result shared by the connect tests: the spec's
// example, patched per case. Test-only by convention (like net/http/httptest).
package discoverytest

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
)

const SpecExample = `{
  "protocolVersion": 1,
  "bundledVersion": "0.37.0",
  "unit": {
    "present": true,
    "wrapperValid": true,
    "target": "/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy",
    "home": "/Users/me/.aio-proxy",
    "owner": "desktop"
  },
  "job": { "loaded": true, "disabled": false, "pid": 4310 },
  "instance": {
    "controlUrl": "http://127.0.0.1:9317",
    "dashboardUrl": "http://127.0.0.1:9317/dashboard",
    "reachable": true,
    "version": "0.36.0",
    "pid": 4312,
    "ppid": 4310,
    "matchesJob": true
  },
  "token": "tok-abc"
}
`

// Doc is the decoded example JSON a patch edits. Paths are dot-separated keys ("unit.owner").
type Doc map[string]any

// Set assigns value at path; nil writes JSON null.
func (d Doc) Set(path string, value any) {
	parent, key := d.parent(path)
	parent[key] = value
}

// Delete removes the key at path.
func (d Doc) Delete(path string) {
	parent, key := d.parent(path)
	delete(parent, key)
}

func (d Doc) parent(path string) (map[string]any, string) {
	keys := strings.Split(path, ".")
	node := map[string]any(d)
	for _, key := range keys[:len(keys)-1] {
		node = node[key].(map[string]any)
	}
	return node, keys[len(keys)-1]
}

// With is the spec example with patch applied to its JSON before parsing. A nil patch parses it
// unchanged.
func With(patch func(Doc)) (discovery.Discovery, error) {
	var doc Doc
	if err := json.Unmarshal([]byte(SpecExample), &doc); err != nil {
		panic("fixture is JSON: " + err.Error())
	}
	if patch != nil {
		patch(doc)
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		panic(err)
	}
	return discovery.ParseDiscovery(encoded)
}

// Must is With for tests that only build valid discoveries.
func Must(t testing.TB, patch func(Doc)) discovery.Discovery {
	t.Helper()
	d, err := With(patch)
	if err != nil {
		t.Fatalf("patched fixture parses: %v", err)
	}
	return d
}
