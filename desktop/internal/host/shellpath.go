package host

import "strings"

// PathWith appends dir unless an entry already equals it, ignoring case and one trailing separator.
// Every other entry stays byte for byte: %VAR% is never expanded.
func PathWith(value, dir string) string {
	for entry := range strings.SplitSeq(value, ";") {
		if sameDir(entry, dir) {
			return value
		}
	}
	kept := strings.TrimRight(value, ";")
	if kept == "" {
		return dir
	}
	return kept + ";" + dir
}

func sameDir(entry, dir string) bool {
	return strings.EqualFold(strings.TrimRight(entry, `\/`), strings.TrimRight(dir, `\/`))
}

// ShimText is a .cmd shim. %~dp0 is relative, so a profile with '%' or a non-ASCII name still works.
const ShimText = "@\"%~dp0..\\aio-proxy.exe\" %*\r\n"

// StartupApprovedDisabled reports a Windows StartupApproved Run value whose first byte is odd.
func StartupApprovedDisabled(b []byte) bool {
	return len(b) > 0 && b[0]%2 == 1
}

// RunValueMatches reports whether a Run-key value is this executable, ignoring case and quotes.
func RunValueMatches(data, exe string) bool {
	return strings.EqualFold(strings.Trim(strings.TrimSpace(data), `"`), exe)
}
