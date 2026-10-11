// Package menubar owns the companion's menu-bar display preferences.
package menubar

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Metric is one menu-bar row. Selection order is display order: the first is the top row.
type Metric int

const (
	TodayTokens Metric = iota
	TokensPerSecond
	TodayCost
	InFlight
	maxMetrics = 2
)

func (m Metric) id() (string, bool) {
	switch m {
	case TodayTokens:
		return "todayTokens", true
	case TokensPerSecond:
		return "tokensPerSecond", true
	case TodayCost:
		return "todayCost", true
	case InFlight:
		return "inFlight", true
	default:
		return "", false
	}
}

func metricByID(id string) (Metric, bool) {
	switch id {
	case "todayTokens":
		return TodayTokens, true
	case "tokensPerSecond":
		return TokensPerSecond, true
	case "todayCost":
		return TodayCost, true
	case "inFlight":
		return InFlight, true
	default:
		return 0, false
	}
}

// Preferences is preferences.json. An empty selection forces the icon on, so the menu stays reachable.
type Preferences struct {
	metrics  [maxMetrics]Metric
	count    int
	ShowIcon bool
}

func DefaultPreferences() Preferences { return Preferences{ShowIcon: true} }

func (p Preferences) Count() int { return p.count }
func (p Preferences) Has(m Metric) bool {
	for i := 0; i < p.count; i++ {
		if p.metrics[i] == m {
			return true
		}
	}
	return false
}
func (p Preferences) Metrics() []Metric {
	out := make([]Metric, p.count)
	copy(out, p.metrics[:p.count])
	return out
}
func (p Preferences) ShowsIcon() bool { return p.ShowIcon || p.count == 0 }
func (p Preferences) Toggle(m Metric) Preferences {
	for i := 0; i < p.count; i++ {
		if p.metrics[i] != m {
			continue
		}
		copy(p.metrics[i:], p.metrics[i+1:])
		p.count--
		p.metrics[p.count] = 0
		return p
	}
	if p.count >= maxMetrics {
		return p
	}
	p.metrics[p.count] = m
	p.count++
	return p
}
func (p Preferences) ToggleIcon() Preferences {
	p.ShowIcon = !p.ShowIcon
	return p
}

type storedPreferences struct {
	TrayMetrics  []string `json:"trayMetrics"`
	TrayShowIcon bool     `json:"trayShowIcon"`
}

func (p Preferences) MarshalJSON() ([]byte, error) {
	ids := make([]string, 0, p.count)
	for i := 0; i < p.count; i++ {
		id, ok := p.metrics[i].id()
		if ok {
			ids = append(ids, id)
		}
	}
	return json.Marshal(storedPreferences{TrayMetrics: ids, TrayShowIcon: p.ShowIcon})
}
func (p *Preferences) UnmarshalJSON(data []byte) error {
	var stored storedPreferences
	if err := json.Unmarshal(data, &stored); err != nil {
		return err
	}
	next := Preferences{ShowIcon: stored.TrayShowIcon}
	seen := map[Metric]bool{}
	for _, id := range stored.TrayMetrics {
		metric, ok := metricByID(id)
		if !ok || seen[metric] || next.count >= maxMetrics {
			continue
		}
		seen[metric] = true
		next.metrics[next.count] = metric
		next.count++
	}
	*p = next
	return nil
}

func preferencePath(support string) string { return filepath.Join(support, "preferences.json") }

// Path is the preferences file for support.
func Path(support string) string { return preferencePath(support) }

// Load reads preferences.json. A missing or unreadable file is the default (icon only) and the
// caller's error says not to overwrite a file this process could not parse.
func Load(support string) (Preferences, error) {
	data, err := os.ReadFile(preferencePath(support))
	if errors.Is(err, os.ErrNotExist) {
		return DefaultPreferences(), nil
	}
	if err != nil {
		return DefaultPreferences(), err
	}
	var p Preferences
	if err = json.Unmarshal(data, &p); err != nil {
		return DefaultPreferences(), err
	}
	return p, nil
}
func Save(support string, p Preferences) error {
	if err := os.MkdirAll(support, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	path := preferencePath(support)
	temp := path + ".tmp"
	if err = os.WriteFile(temp, data, 0o600); err != nil {
		return err
	}
	if err = os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}
