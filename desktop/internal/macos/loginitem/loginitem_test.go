package loginitem

import "testing"

func TestStatusFromRaw(t *testing.T) {
	cases := map[int]LoginItemStatus{
		0:  NotRegistered,
		1:  Enabled,
		2:  RequiresApproval,
		3:  NotFound,
		4:  Unavailable,
		-1: Unavailable,
	}
	for raw, want := range cases {
		if got := statusFromRaw(raw); got != want {
			t.Errorf("statusFromRaw(%d) = %v, want %v", raw, got, want)
		}
	}
}

func TestStatusString(t *testing.T) {
	want := []string{"NotRegistered", "Enabled", "RequiresApproval", "NotFound", "Unavailable"}
	for i, name := range want {
		if got := LoginItemStatus(i).String(); got != name {
			t.Errorf("LoginItemStatus(%d).String() = %q, want %q", i, got, name)
		}
	}
}
