package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var ErrUnauthorized = errors.New("token rejected (revoked or wrong) — create a new token in Settings → Agents")

// HTTPError is a non-2xx answer from the cloud.
type HTTPError struct {
	Status     int
	RetryAfter time.Duration // from the Retry-After header, 0 if absent
	Msg        string
}

func (e *HTTPError) Error() string { return e.Msg }

// rateLimited returns how long to wait when the cloud answered 429.
func rateLimited(err error) (time.Duration, bool) {
	var he *HTTPError
	if !errors.As(err, &he) || he.Status != http.StatusTooManyRequests {
		return 0, false
	}
	if he.RetryAfter > 0 {
		return min(he.RetryAfter, 5*time.Minute), true
	}
	return 10 * time.Second, true
}

// isRejected reports whether the cloud refused the request content itself (4xx other than
// auth, timeout and rate limit). Sending the same body again would fail the same way.
func isRejected(err error) bool {
	var he *HTTPError
	if !errors.As(err, &he) {
		return false
	}
	switch he.Status {
	case 401, 403, 404, 408, 425, 429:
		return false
	}
	return he.Status >= 400 && he.Status < 500
}

// API is the agent's only network peer: the dashboard, over outbound HTTPS (PRD AG-03).
type API struct {
	base   string
	token  string
	client *http.Client
}

func NewAPI(base, token string) *API {
	return &API{base: strings.TrimRight(base, "/"), token: token, client: &http.Client{Timeout: 20 * time.Second}}
}

func (a *API) do(method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, a.base+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("User-Agent", "uptime-monitor-agent/"+version)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusUnauthorized {
		return ErrUnauthorized
	}
	if resp.StatusCode >= 300 {
		ra, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
		return &HTTPError{Status: resp.StatusCode, RetryAfter: time.Duration(ra) * time.Second, Msg: fmt.Sprintf("%s %s: HTTP %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(data[:min(len(data), 200)])))}
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

type ConfigResp struct {
	Agent        struct{ ID, Name string } `json:"agent"`
	HeartbeatSec int                       `json:"heartbeat_sec"`
	ConfigHash   string                    `json:"config_hash"`
	Targets      []Target                  `json:"targets"`
}

type TestReq struct {
	ID   string `json:"id"`
	Spec Target `json:"spec"`
}

type ContactResp struct {
	Tests      []TestReq `json:"tests"`
	ConfigHash string    `json:"config_hash"`
}

type OfflineEvent struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

type ContactReq struct {
	Results       []Result       `json:"results,omitempty"`
	OfflineEvents []OfflineEvent `json:"offline_events,omitempty"`
	Host          string         `json:"host,omitempty"`
	Version       string         `json:"version,omitempty"`
}

func (a *API) Config() (*ConfigResp, error) {
	var c ConfigResp
	return &c, a.do("GET", "/api/agent/config", nil, &c)
}

func (a *API) Ingest(r ContactReq) (*ContactResp, error) {
	var c ContactResp
	return &c, a.do("POST", "/api/agent/ingest", r, &c)
}

func (a *API) Heartbeat(r ContactReq) (*ContactResp, error) {
	var c ContactResp
	return &c, a.do("POST", "/api/agent/heartbeat", r, &c)
}

func (a *API) TestResult(id string, r Result) error {
	return a.do("POST", "/api/agent/test-result", map[string]any{"id": id, "result": r}, nil)
}
