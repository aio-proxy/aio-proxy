package host

import "testing"

func TestPathWith(t *testing.T) {
	dir := `C:\Users\Zoë Chen\AppData\Local\aio-proxy-desktop\bin\shims`
	value := `%USERPROFILE%\bin;C:\Tools;`
	once := PathWith(value, dir)
	if once != `%USERPROFILE%\bin;C:\Tools;`+dir {
		t.Fatal(once)
	}
	if PathWith(once, dir) != once || PathWith(once+`\`, dir) != once+`\` || PathWith("", dir) != dir {
		t.Fatal("idempotent")
	}
	if !isASCII(ShimText) || containsByte(ShimText, ':') {
		t.Fatal(ShimText)
	}
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] > 127 {
			return false
		}
	}
	return true
}
func containsByte(s string, b byte) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return true
		}
	}
	return false
}

func TestStartupApproved(t *testing.T) {
	if !StartupApprovedDisabled([]byte{3, 0}) || StartupApprovedDisabled([]byte{2, 0}) || StartupApprovedDisabled(nil) {
		t.Fatal("flag")
	}
	if !RunValueMatches(`"C:\AIO Proxy\aio-proxy-desktop.exe"`, `c:\aio proxy\aio-proxy-desktop.exe`) {
		t.Fatal("match")
	}
}
