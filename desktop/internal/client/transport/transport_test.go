package transport

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/token"
)

// serve is a one-shot local server: it runs `respond` on the first connection and delivers the
// request head.
func serve(t *testing.T, respond func(net.Conn)) (string, <-chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	heads := make(chan string, 1)
	go func() {
		defer ln.Close()
		conn, err := ln.Accept()
		if err != nil {
			heads <- ""
			return
		}
		defer conn.Close()
		head := readRequestHead(conn)
		respond(conn)
		heads <- head
	}()
	return "http://" + ln.Addr().String(), heads
}

func readRequestHead(conn net.Conn) string {
	r := bufio.NewReader(conn)
	var head strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil || line == "\r\n" {
			return head.String()
		}
		head.WriteString(line)
	}
}

func write(conn net.Conn, s string) error {
	_, err := io.WriteString(conn, s)
	return err
}

func get(t *testing.T, base string, bearer *token.Token) Request {
	t.Helper()
	url, err := ParseLocalURL(base, "/dashboard/api/desktop-summary")
	if err != nil {
		t.Fatal(err)
	}
	return Request{Method: MethodGet, URL: url, Bearer: bearer}
}

func bearer(s string) *token.Token {
	tok := token.New(s)
	return &tok
}

func sendDefault(req Request) (Response, error) {
	return Send(context.Background(), req, DefaultLimits())
}

func TestOnlyALiteralLoopbackIPOverPlainHTTPIsAddressable(t *testing.T) {
	for _, base := range []string{
		"http://localhost:9317",
		"http://192.168.1.2:9317",
		"http://10.0.0.1:9317",
		"http://[::ffff:127.0.0.1]:9317",
		"http://127.0.0.1.nip.io:9317",
		"https://127.0.0.1:9317",
		"http://user:pw@127.0.0.1:9317",
		"http://[::1%25lo0]:9317",
		"http://127.0.0.1:65536",
		"not a url",
	} {
		if _, err := ParseLocalURL(base, "/health"); !errors.Is(err, ErrNotLoopback) {
			t.Errorf("%s: %v", base, err)
		}
	}
	// The whole IPv4 loopback range and ::1, as the CLI reports a configured `server.host`.
	for _, base := range []string{"http://127.0.0.1:9317", "http://127.0.0.5:9317", "http://[::1]:9317", "HTTP://127.0.0.1"} {
		if _, err := ParseLocalURL(base, "/health"); err != nil {
			t.Errorf("%s: %v", base, err)
		}
	}
	if _, err := ParseLocalURL("http://127.0.0.1:9317", "/x\r\nEvil: 1"); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("header injection path: %v", err)
	}
	if _, err := ParseLocalURL("http://127.0.0.1:9317", "health"); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("relative path: %v", err)
	}
}

func TestSendsTheBearerOnlyOnTheRequestThatCarriesIt(t *testing.T) {
	base, heads := serve(t, func(c net.Conn) { write(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok") })
	resp, err := sendDefault(get(t, base, bearer("tok-1")))
	if err != nil || resp.Status != 200 || string(resp.Body) != "ok" {
		t.Fatalf("got %+v, %v", resp, err)
	}
	head := <-heads
	if !strings.HasPrefix(head, "GET /dashboard/api/desktop-summary HTTP/1.1\r\n") {
		t.Fatalf("head %q", head)
	}
	for _, want := range []string{"Authorization: Bearer tok-1\r\n", "Connection: close\r\n", "Accept: application/json\r\n"} {
		if !strings.Contains(head, want) {
			t.Fatalf("head %q lacks %q", head, want)
		}
	}

	base, heads = serve(t, func(c net.Conn) { write(c, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n") })
	if _, err := sendDefault(get(t, base, nil)); err != nil {
		t.Fatal(err)
	}
	if head := <-heads; strings.Contains(strings.ToLower(head), "authorization") {
		t.Fatalf("head %q carries a bearer", head)
	}
}

func TestAPostSendsAnEmptyBody(t *testing.T) {
	base, heads := serve(t, func(c net.Conn) { write(c, "HTTP/1.1 204 No Content\r\n\r\n") })
	url, err := ParseLocalURL(base, "/admin/reload")
	if err != nil {
		t.Fatal(err)
	}
	resp, err := sendDefault(Request{Method: MethodPost, URL: url})
	if err != nil || resp.Status != 204 || len(resp.Body) != 0 {
		t.Fatalf("got %+v, %v", resp, err)
	}
	head := <-heads
	if !strings.HasPrefix(head, "POST /admin/reload HTTP/1.1\r\n") || !strings.Contains(head, "Content-Length: 0\r\n") {
		t.Fatalf("head %q", head)
	}
}

func TestARedirectIsReturnedNotFollowed(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	location := fmt.Sprintf("http://%s/steal", target.Addr())
	base, heads := serve(t, func(c net.Conn) {
		write(c, "HTTP/1.1 302 Found\r\nLocation: "+location+"\r\nContent-Length: 0\r\n\r\n")
	})
	resp, err := sendDefault(get(t, base, bearer("tok-2")))
	if err != nil || resp.Status != 302 {
		t.Fatalf("got %+v, %v", resp, err)
	}
	<-heads
	target.(*net.TCPListener).SetDeadline(time.Now().Add(200 * time.Millisecond))
	if conn, err := target.Accept(); err == nil {
		conn.Close()
		t.Fatal("the redirect target was contacted")
	}
}

func TestProxyEnvironmentVariablesAreIgnored(t *testing.T) {
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		t.Setenv(name, "http://127.0.0.1:1")
	}
	base, heads := serve(t, func(c net.Conn) { write(c, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n") })
	resp, err := sendDefault(get(t, base, nil))
	if err != nil || resp.Status != 200 {
		t.Fatalf("got %+v, %v", resp, err)
	}
	<-heads
}

func TestASlowDripIsCutOffAtTheTotalDeadline(t *testing.T) {
	base, heads := serve(t, func(c net.Conn) {
		write(c, "HTTP/1.1 200 OK\r\n")
		for range 40 {
			time.Sleep(100 * time.Millisecond)
			if write(c, "X") != nil {
				return
			}
		}
	})
	limits := DefaultLimits()
	limits.Total = 700 * time.Millisecond
	started := time.Now()
	_, err := Send(context.Background(), get(t, base, nil), limits)
	elapsed := time.Since(started)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("got %v", err)
	}
	if elapsed < 650*time.Millisecond || elapsed >= 1200*time.Millisecond {
		t.Fatalf("elapsed %v", elapsed)
	}
	<-heads
}

func TestDecodesAChunkedBody(t *testing.T) {
	base, heads := serve(t, func(c net.Conn) {
		write(c, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\nX-Trailer: t\r\n\r\n")
	})
	resp, err := sendDefault(get(t, base, nil))
	if err != nil || string(resp.Body) != `{"a":1}` {
		t.Fatalf("got %q, %v", resp.Body, err)
	}
	<-heads
}

func TestAnOversizedResponseIsRefused(t *testing.T) {
	limits := DefaultLimits()
	limits.MaxBody = 16
	for _, head := range []string{
		"HTTP/1.1 200 OK\r\nContent-Length: 17\r\n\r\n",
		"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n11\r\n",
		"HTTP/1.1 200 OK\r\n\r\n",
	} {
		base, heads := serve(t, func(c net.Conn) {
			write(c, head)
			write(c, strings.Repeat("x", 64))
		})
		if _, err := Send(context.Background(), get(t, base, nil), limits); !errors.Is(err, ErrTooLarge) {
			t.Fatalf("%q: got %v", head, err)
		}
		<-heads
	}
}

func TestOversizedHeadersAreRefused(t *testing.T) {
	base, heads := serve(t, func(c net.Conn) {
		write(c, "HTTP/1.1 200 OK\r\n")
		for range 20 {
			write(c, "X-Pad: "+strings.Repeat("p", 1024)+"\r\n")
		}
		write(c, "\r\n")
	})
	if _, err := sendDefault(get(t, base, nil)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("got %v", err)
	}
	<-heads
}

func TestCancellingARequestShutsItsSocket(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	req := get(t, "http://"+ln.Addr().String(), nil)
	go func() {
		_, err := Send(ctx, req, DefaultLimits())
		result <- err
	}()
	conn, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	readRequestHead(conn)
	cancel()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var b [1]byte
	if n, err := conn.Read(b[:]); n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("peer should see EOF after the cancel: %d, %v", n, err)
	}
	if err := <-result; !errors.Is(err, ErrCancelled) {
		t.Fatalf("got %v", err)
	}
}

func TestANonSuccessStatusIsAResponse(t *testing.T) {
	base, heads := serve(t, func(c net.Conn) { write(c, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n") })
	resp, err := sendDefault(get(t, base, nil))
	if err != nil || resp.Status != 404 {
		t.Fatalf("got %+v, %v", resp, err)
	}
	<-heads
}

func TestACancelMidBodyIsCancelledNotATruncatedSuccess(t *testing.T) {
	// No Content-Length and not chunked: the body runs to EOF, which a cancel's close also produces.
	base, heads := serve(t, func(c net.Conn) {
		write(c, "HTTP/1.1 200 OK\r\n\r\n{\"partial\":")
		time.Sleep(600 * time.Millisecond)
	})
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(200*time.Millisecond, cancel)
	started := time.Now()
	_, err := Send(ctx, get(t, base, nil), DefaultLimits())
	if !errors.Is(err, ErrCancelled) {
		t.Fatalf("got %v", err)
	}
	if time.Since(started) >= 2*time.Second {
		t.Fatalf("took %v", time.Since(started))
	}
	<-heads
}

func TestATokenThatCouldInjectAHeaderIsNeverSent(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	base := "http://" + ln.Addr().String()
	for _, bad := range []string{"tok\r\nX-Evil: 1", "tok\n", "has space", "tab\t", "", "caf\u00e9", "del\x7f"} {
		if _, err := sendDefault(get(t, base, bearer(bad))); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("%q: got %v", bad, err)
		}
	}
	ln.(*net.TCPListener).SetDeadline(time.Now().Add(100 * time.Millisecond))
	if conn, err := ln.Accept(); err == nil {
		conn.Close()
		t.Fatal("a request went out with an invalid token")
	}
}

func TestAnInterim100ContinueIsSkippedButAnUpgradeIsRefused(t *testing.T) {
	base, heads := serve(t, func(c net.Conn) {
		write(c, "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	})
	resp, err := sendDefault(get(t, base, nil))
	if err != nil || resp.Status != 200 || string(resp.Body) != "ok" {
		t.Fatalf("got %+v, %v", resp, err)
	}
	<-heads

	base, heads = serve(t, func(c net.Conn) { write(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\n\r\n") })
	if _, err := sendDefault(get(t, base, nil)); !errors.Is(err, ErrMalformed) {
		t.Fatalf("got %v", err)
	}
	<-heads
}

// Rust's `Instant + Duration::MAX` overflow has no Go counterpart (time.Time spans it); the rules it
// protected still hold: an exhausted deadline is a Timeout and a huge one does not panic.
func TestAnExhaustedOrHugeTotalDeadlineIsHandled(t *testing.T) {
	limits := DefaultLimits()
	limits.Total = 0
	if _, err := Send(context.Background(), get(t, "http://127.0.0.1:1", nil), limits); !errors.Is(err, ErrTimeout) {
		t.Fatalf("zero total: got %v", err)
	}
	limits.Total = math.MaxInt64
	if _, err := Send(context.Background(), get(t, "http://127.0.0.1:1", nil), limits); err == nil {
		t.Fatal("port 1 answered")
	}
}

func TestAnAlreadyCancelledContextNeverConnects(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Send(ctx, get(t, "http://"+ln.Addr().String(), nil), DefaultLimits()); !errors.Is(err, ErrCancelled) {
		t.Fatalf("got %v", err)
	}
	ln.(*net.TCPListener).SetDeadline(time.Now().Add(100 * time.Millisecond))
	if conn, err := ln.Accept(); err == nil {
		conn.Close()
		t.Fatal("a cancelled request connected")
	}
}
