package clicommand

import "testing"

func TestParseProbeIgnoresShellChatter(t *testing.T) {
	stdout := "welcome\naio-proxy-probe:aiop\nnoise\naio-proxy-probe:path:/usr/local/bin:/usr/bin\n"
	probe := ParseProbe(stdout, "/usr/local/bin")
	if probe == nil || !probe.Aiop || probe.AioProxy || !probe.LinkDirOnPath {
		t.Fatalf("%+v", probe)
	}
}

func TestParseProbeNeedsThePathLine(t *testing.T) {
	if ParseProbe("aio-proxy-probe:aiop\n", "/usr/local/bin") != nil {
		t.Fatal("a probe without the path line is not proof the shell answered")
	}
}

func TestParseProbeAcceptsFishPathAndTrailingSlashes(t *testing.T) {
	stdout := "aio-proxy-probe:aio-proxy\naio-proxy-probe:path:/usr/bin /usr/local/bin/\n"
	probe := ParseProbe(stdout, "/usr/local/bin")
	if probe == nil || probe.Aiop || !probe.AioProxy || !probe.LinkDirOnPath {
		t.Fatalf("%+v", probe)
	}
}
