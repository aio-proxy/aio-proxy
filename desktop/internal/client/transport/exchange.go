package transport

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math"
	"net"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aio-proxy/aio-proxy/desktop/internal/client/listener"
)

// Send runs one blocking exchange. Cancelling `ctx` closes the socket and the result is
// ErrCancelled; a deadline on `ctx` shortens the total deadline and reads as ErrTimeout.
func Send(ctx context.Context, req Request, limits Limits) (Response, error) {
	if err := ctxError(ctx); err != nil {
		return Response{}, err
	}
	deadline := time.Now().Add(limits.Total)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	resp, err := exchange(ctx, req, limits, deadline)
	// A cancel closes the socket, which a read without a length reads as a clean EOF and would
	// return as a truncated success; whatever the result was, a cancelled exchange is Cancelled.
	if cerr := ctxError(ctx); cerr != nil {
		return Response{}, cerr
	}
	return resp, err
}

func ctxError(ctx context.Context) error {
	switch ctx.Err() {
	case nil:
		return nil
	case context.DeadlineExceeded:
		return ErrTimeout
	default:
		return ErrCancelled
	}
}

func exchange(ctx context.Context, req Request, limits Limits, deadline time.Time) (Response, error) {
	head, err := buildHead(req)
	if err != nil {
		return Response{}, err
	}
	left, err := remaining(deadline)
	if err != nil {
		return Response{}, err
	}
	dialer := net.Dialer{Timeout: min(limits.Connect, left)}
	conn, err := dialer.DialContext(ctx, "tcp", req.URL.addr.String())
	if err != nil {
		if isTimeout(err) {
			return Response{}, ErrTimeout
		}
		return Response{}, &Error{Kind: KindConnect, Err: err}
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	// Checked on the connection that would carry the token: the proxy may have exited since
	// discovery, and another account may hold the port, or may have accepted this very connection
	// and handed the port back; only this connection's serving socket decides.
	if req.Bearer != nil && !listener.PeerOwnedByThisUser(ctx, conn, deadline) {
		return Response{}, ErrUntrustedListener
	}
	if _, err := remaining(deadline); err != nil {
		return Response{}, err
	}
	// One absolute deadline covers the write and every read, so a server dripping one byte at a
	// time still hits it.
	if err := conn.SetDeadline(deadline); err != nil {
		return Response{}, ioError(err)
	}
	if _, err := io.WriteString(conn, head); err != nil {
		return Response{}, ioError(err)
	}
	r := &reader{conn: conn}
	return readResponse(r, limits.MaxBody)
}

func buildHead(req Request) (string, error) {
	var b strings.Builder
	b.WriteString(req.Method.String() + " " + req.URL.path + " HTTP/1.1\r\nHost: " + req.URL.addr.String() +
		"\r\nConnection: close\r\nAccept: application/json\r\n")
	if req.Method == MethodPost {
		b.WriteString("Content-Length: 0\r\n")
	}
	if req.Bearer != nil {
		// Tokens arrive as JSON, where `\r\n` can be escaped into a value; refuse rather than send.
		value := req.Bearer.Expose()
		if value == "" || strings.ContainsFunc(value, func(r rune) bool { return r < '!' || r > '~' }) {
			return "", ErrInvalidToken
		}
		b.WriteString("Authorization: Bearer " + value + "\r\n")
	}
	b.WriteString("\r\n")
	return b.String(), nil
}

func remaining(deadline time.Time) (time.Duration, error) {
	left := time.Until(deadline)
	if left <= 0 {
		return 0, ErrTimeout
	}
	return left, nil
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func ioError(err error) error {
	if isTimeout(err) {
		return ErrTimeout
	}
	return &Error{Kind: KindIO, Err: err}
}

type reader struct {
	conn net.Conn
	buf  []byte
	pos  int
}

// fill reads more bytes; false at EOF.
func (r *reader) fill() (bool, error) {
	if r.pos > 0 {
		r.buf = append(r.buf[:0], r.buf[r.pos:]...)
		r.pos = 0
	}
	var chunk [8192]byte
	n, err := r.conn.Read(chunk[:])
	if n > 0 {
		r.buf = append(r.buf, chunk[:n]...)
		return true, nil
	}
	if err == nil || errors.Is(err, io.EOF) {
		// A zero-byte read without an error does not happen on a TCP conn; treat it as EOF.
		return false, nil
	}
	return false, ioError(err)
}

func (r *reader) line(max int) ([]byte, error) {
	for {
		if at := bytes.IndexByte(r.buf[r.pos:], '\n'); at >= 0 {
			line := r.buf[r.pos : r.pos+at]
			r.pos += at + 1
			return bytes.Clone(bytes.TrimSuffix(line, []byte{'\r'})), nil
		}
		if len(r.buf)-r.pos > max {
			return nil, ErrTooLarge
		}
		more, err := r.fill()
		if err != nil {
			return nil, err
		}
		if !more {
			return nil, malformed("connection closed mid-line")
		}
	}
}

func (r *reader) exact(n int) ([]byte, error) {
	for len(r.buf)-r.pos < n {
		more, err := r.fill()
		if err != nil {
			return nil, err
		}
		if !more {
			return nil, malformed("connection closed mid-body")
		}
	}
	out := bytes.Clone(r.buf[r.pos : r.pos+n])
	r.pos += n
	return out, nil
}

func (r *reader) rest(max int) ([]byte, error) {
	for {
		more, err := r.fill()
		if err != nil {
			return nil, err
		}
		if len(r.buf)-r.pos > max {
			return nil, ErrTooLarge
		}
		if !more {
			return bytes.Clone(r.buf[r.pos:]), nil
		}
	}
}

func readResponse(r *reader, maxBody int) (Response, error) {
	var h head
	for {
		var err error
		if h, err = readHead(r); err != nil {
			return Response{}, err
		}
		if h.status == 101 {
			return Response{}, malformed("unexpected protocol upgrade")
		}
		// Interim responses precede the final one on the same connection.
		if h.status < 100 || h.status > 199 {
			break
		}
	}
	var body []byte
	var err error
	switch {
	case h.status == 204 || h.status == 304:
		body = []byte{}
	case h.chunked:
		body, err = readChunked(r, maxBody)
	case h.contentLength >= 0:
		if h.contentLength > maxBody {
			return Response{}, ErrTooLarge
		}
		body, err = r.exact(h.contentLength)
	default:
		body, err = r.rest(maxBody)
	}
	if err != nil {
		return Response{}, err
	}
	return Response{Status: h.status, Body: body}, nil
}

type head struct {
	status int
	// -1 when absent.
	contentLength int
	chunked       bool
}

func readHead(r *reader) (head, error) {
	statusLine, err := r.line(maxHeaderBytes)
	if err != nil {
		return head{}, err
	}
	h := head{status: -1, contentLength: -1}
	if utf8.Valid(statusLine) && bytes.HasPrefix(statusLine, []byte("HTTP/1.")) {
		if fields := strings.Split(string(statusLine), " "); len(fields) > 1 {
			if code, err := strconv.ParseUint(fields[1], 10, 16); err == nil {
				h.status = int(code)
			}
		}
	}
	if h.status < 0 {
		return head{}, malformed("status line")
	}
	headerBytes := len(statusLine)
	for {
		line, err := r.line(maxHeaderBytes)
		if err != nil {
			return head{}, err
		}
		headerBytes += len(line)
		if headerBytes > maxHeaderBytes {
			return head{}, ErrTooLarge
		}
		if len(line) == 0 {
			return h, nil
		}
		name, value, ok := strings.Cut(strings.ToValidUTF8(string(line), "\uFFFD"), ":")
		if !ok {
			return head{}, malformed("header line")
		}
		name, value = strings.TrimSpace(name), strings.TrimSpace(value)
		switch {
		case strings.EqualFold(name, "content-length"):
			n, err := strconv.ParseUint(value, 10, 64)
			if err != nil || n > math.MaxInt {
				return head{}, malformed("content-length")
			}
			h.contentLength = int(n)
		case strings.EqualFold(name, "transfer-encoding"):
			h.chunked = false
			for coding := range strings.SplitSeq(value, ",") {
				if strings.EqualFold(strings.TrimSpace(coding), "chunked") {
					h.chunked = true
				}
			}
		}
	}
}

func readChunked(r *reader, maxBody int) ([]byte, error) {
	body := []byte{}
	for {
		line, err := r.line(maxHeaderBytes)
		if err != nil {
			return nil, err
		}
		sizeText, _, _ := strings.Cut(string(line), ";")
		size, err := strconv.ParseUint(strings.TrimSpace(sizeText), 16, 64)
		if err != nil {
			return nil, malformed("chunk size")
		}
		if size == 0 {
			for {
				trailer, err := r.line(maxHeaderBytes)
				if err != nil {
					return nil, err
				}
				if len(trailer) == 0 {
					return body, nil
				}
			}
		}
		if size > uint64(maxBody-len(body)) {
			return nil, ErrTooLarge
		}
		chunk, err := r.exact(int(size))
		if err != nil {
			return nil, err
		}
		body = append(body, chunk...)
		terminator, err := r.line(maxHeaderBytes)
		if err != nil {
			return nil, err
		}
		if len(terminator) != 0 {
			return nil, malformed("chunk terminator")
		}
	}
}
