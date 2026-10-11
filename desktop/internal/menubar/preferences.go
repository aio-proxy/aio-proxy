// Package menubar owns the companion's menu-bar display preferences and sampled statistics.
package menubar

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type Option int

const (
	TodayTokens Option = iota
	TokensPerSecond
	ShowIcon
)

type Preferences struct {
	TodayTokens     bool `json:"todayTokens"`
	TokensPerSecond bool `json:"tokensPerSecond"`
	ShowIcon        bool `json:"showIcon"`
}

func DefaultPreferences() Preferences {
	return Preferences{TodayTokens: true, TokensPerSecond: true, ShowIcon: true}
}
func (p Preferences) MetricsEnabled() bool { return p.TodayTokens || p.TokensPerSecond }
func (p Preferences) Visible() bool        { return p.MetricsEnabled() || p.ShowIcon }
func (p Preferences) Selected(option Option) bool {
	switch option {
	case TodayTokens:
		return p.TodayTokens
	case TokensPerSecond:
		return p.TokensPerSecond
	case ShowIcon:
		return p.ShowIcon
	}
	return false
}
func (p Preferences) Toggle(option Option) Preferences {
	original := p
	switch option {
	case TodayTokens:
		p.TodayTokens = !p.TodayTokens
	case TokensPerSecond:
		p.TokensPerSecond = !p.TokensPerSecond
	case ShowIcon:
		p.ShowIcon = !p.ShowIcon
	}
	// Never remove the last visible control: the user must be able to open the menu again.
	if !p.Visible() {
		return original
	}
	return p
}
func preferencePath(support string) string { return filepath.Join(support, "menu-bar-display.json") }
func Load(support string) (Preferences, error) {
	p := DefaultPreferences()
	data, err := os.ReadFile(preferencePath(support))
	if errors.Is(err, os.ErrNotExist) {
		return p, nil
	}
	if err != nil {
		return p, err
	}
	if err = json.Unmarshal(data, &p); err != nil {
		return DefaultPreferences(), err
	}
	if !p.Visible() {
		p.ShowIcon = true
	}
	return p, nil
}
func Save(support string, p Preferences) error {
	if err := os.MkdirAll(support, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(support, ".menu-bar-display-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), preferencePath(support))
}
