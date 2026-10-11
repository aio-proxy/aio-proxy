package version

import "testing"

func TestComparesBySemverPrecedenceNotStringOrder(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		want int
	}{
		{"0.9.0", "0.10.0", -1},
		{"0.36.0", "0.37.0", -1},
		{"0.37.0", "0.37.0", 0},
		{"1.0.0", "0.99.9", 1},
		{"0.37.0-canary.20260930", "0.37.0", -1},
		{"0.37.0+build.5", "0.37.0", 0},
	} {
		got, ok := Compare(tc.a, tc.b)
		if !ok || got != tc.want {
			t.Errorf("Compare(%q, %q) = %d, %v; want %d", tc.a, tc.b, got, ok, tc.want)
		}
	}
}

func TestAnUnparsableVersionIsUnknownNotOlder(t *testing.T) {
	for _, pair := range [][2]string{{"garbage", "0.37.0"}, {"0.37.0", ""}, {"0.37", "0.37.0"}, {"v0.37.0", "0.37.0"}} {
		if _, ok := Compare(pair[0], pair[1]); ok {
			t.Errorf("Compare(%q, %q) parsed", pair[0], pair[1])
		}
	}
}

func TestReadsTheVersionLineFromCLIOutput(t *testing.T) {
	if got, ok := ParseOutput("0.37.0\n"); !ok || got != "0.37.0" {
		t.Errorf("ParseOutput = %q, %v", got, ok)
	}
	for _, out := range []string{"Unexpected internal error\n", ""} {
		if _, ok := ParseOutput(out); ok {
			t.Errorf("ParseOutput(%q) parsed", out)
		}
	}
}
