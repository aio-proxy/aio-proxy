//go:build !linux

package main

import "github.com/aio-proxy/aio-proxy/desktop/internal/app"

func openShell(*app.Model) {}
