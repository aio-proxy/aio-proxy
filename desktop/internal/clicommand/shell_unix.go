//go:build unix

package clicommand

import (
	"os"
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

func loginShell() string {
	if shell := accountShell(); shell != "" {
		return shell
	}
	return "/bin/zsh"
}

type darwinPasswd struct {
	name, passwd      unsafe.Pointer
	uid, gid          uint32
	change            int64
	class, gecos, dir unsafe.Pointer
	shell             unsafe.Pointer
	expire            int64
}

type linuxPasswd struct {
	name, passwd      unsafe.Pointer
	uid, gid          uint32
	gecos, dir, shell unsafe.Pointer
}

var (
	shellOnce sync.Once
	getpwuid  func(uid uint32) unsafe.Pointer
)

func accountShell() string {
	shellOnce.Do(func() {
		path := "libc.so.6"
		if runtime.GOOS == "darwin" {
			path = "/usr/lib/libSystem.B.dylib"
		}
		lib, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		purego.RegisterLibFunc(&getpwuid, lib, "getpwuid")
	})
	if getpwuid == nil {
		return ""
	}
	entry := getpwuid(uint32(os.Getuid()))
	if entry == nil {
		return ""
	}
	var shell unsafe.Pointer
	if runtime.GOOS == "darwin" {
		shell = (*darwinPasswd)(entry).shell
	} else {
		shell = (*linuxPasswd)(entry).shell
	}
	return cString(shell)
}

func cString(p unsafe.Pointer) string {
	if p == nil {
		return ""
	}
	buf := make([]byte, 0, 64)
	for range 1024 {
		c := *(*byte)(p)
		if c == 0 {
			break
		}
		buf = append(buf, c)
		p = unsafe.Add(p, 1)
	}
	return string(buf)
}
