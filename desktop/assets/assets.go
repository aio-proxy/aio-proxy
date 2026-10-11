// Package assets embeds the menu-bar mark derived from @aio-proxy/brand.
package assets

import _ "embed"

//go:embed tray-mark.png
var TrayMark []byte

//go:embed tray-mark-square.png
var TrayMarkSquare []byte
