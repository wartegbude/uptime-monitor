package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

func TestClipText(t *testing.T) {
	if got := clipText("abc", 5); got != "abc" {
		t.Errorf("short string changed: %q", got)
	}
	long := strings.Repeat("é", 400) // 800 bytes
	got := clipText(long, maxTextLen)
	if len(got) > maxTextLen || !utf8.ValidString(got) {
		t.Errorf("clipText: len=%d valid=%v", len(got), utf8.ValidString(got))
	}
}

func TestIsRejected(t *testing.T) {
	cases := map[int]bool{400: true, 413: true, 422: true, 401: false, 403: false, 404: false, 429: false, 500: false, 502: false}
	for code, want := range cases {
		if got := isRejected(&HTTPError{Status: code}); got != want {
			t.Errorf("isRejected(%d)=%v want %v", code, got, want)
		}
	}
	if isRejected(context.DeadlineExceeded) {
		t.Error("network error must not count as rejected")
	}
}

// runSender runs the sender loop against a fake cloud whose ingest answers ingestStatus.
func runSender(t *testing.T, ingestStatus int) (buf *Buffer, ingests, heartbeats int32) {
	t.Helper()
	var ni, nh atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/ingest":
			ni.Add(1)
			w.WriteHeader(ingestStatus)
			w.Write([]byte(`{"error":"x"}`))
		case "/api/agent/heartbeat":
			nh.Add(1)
			w.Write([]byte(`{"ok":true,"tests":[]}`))
		}
	}))
	defer srv.Close()

	buf, err := OpenBuffer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	buf.Append(Result{TargetID: "t1", CheckedAt: time.Now().UTC().Format(time.RFC3339Nano)})
	a := &Agent{api: NewAPI(srv.URL, "ag_test_token_123456789"), buf: buf, refetch: make(chan struct{}, 1)}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	a.senderLoop(ctx)
	return buf, ni.Load(), nh.Load()
}

func TestSenderDropsRejectedBatch(t *testing.T) {
	buf, ingests, heartbeats := runSender(t, 400)
	if seg, _ := buf.Oldest(); seg != "" {
		t.Errorf("rejected segment still in buffer: %s", seg)
	}
	if ingests != 1 {
		t.Errorf("rejected batch sent %d times, want 1", ingests)
	}
	if heartbeats < 1 {
		t.Error("heartbeat blocked after a rejected batch")
	}
}

func TestSenderKeepsBatchOnServerError(t *testing.T) {
	buf, _, heartbeats := runSender(t, 500)
	if seg, _ := buf.Oldest(); seg == "" {
		t.Error("batch lost on a 500; it must stay buffered for retry")
	}
	if heartbeats != 0 {
		t.Errorf("heartbeat sent while results are still waiting: %d", heartbeats)
	}
}
