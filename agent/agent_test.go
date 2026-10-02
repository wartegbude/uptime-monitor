package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestOKCode(t *testing.T) {
	cases := []struct {
		spec string
		code int
		ok   bool
	}{
		{"", 200, true}, {"", 301, true}, {"", 404, false},
		{"200-299, 401", 401, true}, {"200-299, 401", 302, false}, {"204", 204, true},
	}
	for _, c := range cases {
		if got := okCode(c.spec, c.code); got != c.ok {
			t.Errorf("okCode(%q,%d)=%v want %v", c.spec, c.code, got, c.ok)
		}
	}
}

func TestHTTPCheck(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/slow":
			time.Sleep(300 * time.Millisecond)
		case "/err":
			w.WriteHeader(503)
			return
		}
		w.Write([]byte("ok"))
	}))
	defer srv.Close()

	r := RunCheck(Target{ID: "a", Method: "http", Address: srv.URL, TimeoutMs: 2000})
	if !r.Success || r.ResponseMs == nil || *r.StatusCode != 200 {
		t.Fatalf("expected success, got %+v", r)
	}
	r = RunCheck(Target{ID: "a", Method: "http", Address: srv.URL + "/err", TimeoutMs: 2000})
	if r.Success || r.ErrorKind != "status" {
		t.Fatalf("expected status error, got %+v", r)
	}
	r = RunCheck(Target{ID: "a", Method: "http", Address: srv.URL + "/slow", TimeoutMs: 100})
	if r.Success || r.ErrorKind != "timeout" {
		t.Fatalf("expected timeout, got %+v", r)
	}
	r = RunCheck(Target{ID: "a", Method: "http", Address: "http://127.0.0.1:1", TimeoutMs: 1000})
	if r.Success || r.ErrorKind != "conn" {
		t.Fatalf("expected conn refused, got %+v", r)
	}
}

func TestPingLoopback(t *testing.T) {
	r := RunCheck(Target{ID: "p", Method: "ping", Address: "127.0.0.1", TimeoutMs: 2000})
	if !r.Success {
		t.Skipf("ICMP not permitted in this environment: %s", r.Error)
	}
	if *r.PacketLoss != 0 || *r.ResponseMs <= 0 {
		t.Fatalf("unexpected ping result %+v", r)
	}
}

func TestDNSLocalhost(t *testing.T) {
	r := RunCheck(Target{ID: "d", Method: "dns", Address: "localhost", TimeoutMs: 2000})
	if !r.Success {
		t.Fatalf("expected localhost to resolve: %+v", r)
	}
}

func TestBufferRoundTrip(t *testing.T) {
	b, err := OpenBuffer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < segmentLines+10; i++ {
		b.Append(Result{TargetID: "t", CheckedAt: time.Now().Format(time.RFC3339Nano)})
	}
	seg, rs := b.Oldest()
	if seg == "" || len(rs) != segmentLines {
		t.Fatalf("first closed segment should hold %d results, got %d", segmentLines, len(rs))
	}
	b.Done(seg)
	if seg2, _ := b.Oldest(); seg2 != "" {
		t.Fatalf("active segment must not be returned before Flush")
	}
	b.Flush()
	if _, rs := b.Oldest(); len(rs) != 10 {
		t.Fatalf("expected 10 results after flush, got %d", len(rs))
	}
}
