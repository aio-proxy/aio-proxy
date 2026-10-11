// Package transport is a minimal HTTP/1.1 client for the local instance only (spike check 2: the one
// stack meeting every transport rule). It never reads proxy settings, never follows redirects, speaks
// plain HTTP only to a literal loopback IP, and bounds the whole exchange by one total deadline.
//
// It is a raw TCP client rather than net/http on purpose: net/http's Transport reads proxy settings,
// pools connections, handles 1xx/101 and bodies its own way, and offers no point between connect and
// write for the same-user listener check that gates the bearer.
package transport

import (
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/token"
)

const maxHeaderBytes = 16 * 1024

type Limits struct {
	Connect time.Duration
	// Raced against the whole request: connect, write, and every read share this one deadline.
	Total   time.Duration
	MaxBody int
}

func DefaultLimits() Limits {
	return Limits{Connect: time.Second, Total: 5 * time.Second, MaxBody: 4 * 1024 * 1024}
}

// LocalURL is a URL on the local instance. Constructing one is the only way to address a request, so
// a hostname, a non-loopback address or HTTPS can never carry the token.
type LocalURL struct {
	addr netip.AddrPort
	path string
}

// ParseLocalURL takes `base` as `instance.controlUrl` (`http://127.0.0.1:9317`, `http://[::1]:9317`);
// `path` is absolute, with an optional query.
func ParseLocalURL(base, path string) (LocalURL, error) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Opaque != "" || u.Host == "" {
		return LocalURL{}, ErrNotLoopback
	}
	ip, err := netip.ParseAddr(u.Hostname())
	// All of 127.0.0.0/8 and ::1, as the CLI's `localControlHost` and the server accept: a config may
	// bind 127.0.0.5. An IPv4-mapped IPv6 address is not loopback here, and neither is a zoned one.
	if err != nil || ip.Is4In6() || ip.Zone() != "" || !ip.IsLoopback() {
		return LocalURL{}, ErrNotLoopback
	}
	if !strings.HasPrefix(path, "/") || strings.ContainsFunc(path, func(r rune) bool { return r <= ' ' || r == 0x7f }) {
		return LocalURL{}, ErrInvalidPath
	}
	port := uint64(80)
	if p := u.Port(); p != "" {
		if port, err = strconv.ParseUint(p, 10, 16); err != nil {
			return LocalURL{}, ErrNotLoopback
		}
	}
	return LocalURL{addr: netip.AddrPortFrom(ip, uint16(port)), path: path}, nil
}

type Method int

const (
	MethodGet Method = iota
	MethodPost
)

func (m Method) String() string {
	if m == MethodPost {
		return "POST"
	}
	return "GET"
}

type Request struct {
	Method Method
	URL    LocalURL
	// Set per request, never as a default; the URL type already guarantees a loopback literal.
	Bearer *token.Token
}

type Response struct {
	Status int
	Body   []byte
}

type Kind int

const (
	KindNotLoopback Kind = iota + 1
	KindInvalidPath
	KindConnect
	KindTimeout
	KindIO
	KindMalformed
	KindTooLarge
	KindCancelled
	// The bearer holds a byte that is not visible ASCII, which could inject header lines.
	KindInvalidToken
	// No listener of this user serves the address, so the bearer is not sent.
	KindUntrustedListener
)

// Error is every failure of a request. `What` names the malformed part; `Err` is the underlying
// connect or I/O error.
type Error struct {
	Kind Kind
	What string
	Err  error
}

// Sentinels for errors.Is, which matches any *Error of the same Kind.
var (
	ErrNotLoopback       = &Error{Kind: KindNotLoopback}
	ErrInvalidPath       = &Error{Kind: KindInvalidPath}
	ErrConnect           = &Error{Kind: KindConnect}
	ErrTimeout           = &Error{Kind: KindTimeout}
	ErrIO                = &Error{Kind: KindIO}
	ErrMalformed         = &Error{Kind: KindMalformed}
	ErrTooLarge          = &Error{Kind: KindTooLarge}
	ErrCancelled         = &Error{Kind: KindCancelled}
	ErrInvalidToken      = &Error{Kind: KindInvalidToken}
	ErrUntrustedListener = &Error{Kind: KindUntrustedListener}
)

func (e *Error) Error() string {
	switch e.Kind {
	case KindNotLoopback:
		return "the control address is not a loopback IP"
	case KindInvalidPath:
		return "invalid request path"
	case KindConnect:
		return fmt.Sprintf("cannot connect: %v", e.Err)
	case KindTimeout:
		return "timed out"
	case KindIO:
		return fmt.Sprintf("connection error: %v", e.Err)
	case KindMalformed:
		return "malformed response: " + e.What
	case KindTooLarge:
		return "response too large"
	case KindCancelled:
		return "cancelled"
	case KindInvalidToken:
		return "the token is not a valid header value"
	case KindUntrustedListener:
		return "the proxy's port is not served by this user's process; usage is not requested"
	}
	return "unknown transport error"
}

func (e *Error) Unwrap() error { return e.Err }

func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.Kind == e.Kind
}

func malformed(what string) error { return &Error{Kind: KindMalformed, What: what} }
