// Package clicommand is the aiop shell command: whether the user's shell finds one, and installing ours.
package clicommand

import "strings"

const probeMark = "aio-proxy-probe:"

// Probe is what the user's shell resolves. A nil result from Query means the shell could not answer.
type Probe struct {
	Aiop          bool
	AioProxy      bool
	LinkDirOnPath bool
}

// ParseProbe reads the marker lines a login shell printed. Chatter before them is ignored.
// A missing PATH line means the lookups never ran.
func ParseProbe(stdout, linkDir string) *Probe {
	var marks []string
	for line := range strings.SplitSeq(stdout, "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), probeMark); ok {
			marks = append(marks, rest)
		}
	}
	var path string
	found := false
	for _, mark := range marks {
		if rest, ok := strings.CutPrefix(mark, "path:"); ok {
			path = rest
			found = true
			break
		}
	}
	if !found {
		return nil
	}
	probe := &Probe{}
	for _, mark := range marks {
		switch mark {
		case "aiop":
			probe.Aiop = true
		case "aio-proxy":
			probe.AioProxy = true
		}
	}
	if linkDir == "" {
		return probe
	}
	want := strings.TrimRight(linkDir, "/")
	for dir := range strings.FieldsFuncSeq(path, func(r rune) bool { return r == ':' || r == ' ' }) {
		if strings.TrimRight(dir, "/") == want {
			probe.LinkDirOnPath = true
			break
		}
	}
	return probe
}
