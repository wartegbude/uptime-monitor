package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"sync"
	"time"
)

const (
	heartbeatEvery = 30 * time.Second // PRD AG-09
	configEvery    = 60 * time.Second
	delayedAfter   = 60 * time.Second // results older than this when sent came from the offline buffer
	sendEvery      = 10 * time.Second // batch live results to keep serverless invocations low
	maxBackoff     = 15 * time.Second // keep reconnect fast so recovery is reported quickly
)

type Agent struct {
	cfg       Config
	api       *API
	buf       *Buffer
	sched     *Scheduler
	cachePath string

	mu           sync.Mutex
	configHash   string
	refetch      chan struct{}
	offlineSince time.Time    // first failed contact of the current outage
	lastOutage   [2]time.Time // [start, end) of the most recent outage; results checked inside it came from the buffer
}

func (a *Agent) loadCachedConfig() {
	a.refetch = make(chan struct{}, 1)
	b, err := os.ReadFile(a.cachePath)
	if err != nil {
		return
	}
	var c ConfigResp
	if json.Unmarshal(b, &c) == nil {
		a.configHash = c.ConfigHash
		a.sched.Apply(c.Targets)
		log.Printf("loaded cached config: %d targets", len(c.Targets))
	}
}

func (a *Agent) fetchConfig() {
	c, err := a.api.Config()
	if err != nil {
		if errors.Is(err, ErrUnauthorized) {
			log.Printf("config: %v", err)
		}
		return
	}
	a.mu.Lock()
	changed := c.ConfigHash != a.configHash
	a.configHash = c.ConfigHash
	a.mu.Unlock()
	if changed {
		log.Printf("config: %d targets (hash %s)", len(c.Targets), c.ConfigHash)
		a.sched.Apply(c.Targets)
		if b, err := json.Marshal(c); err == nil {
			tmp := a.cachePath + ".tmp"
			if os.WriteFile(tmp, b, 0o640) == nil {
				os.Rename(tmp, a.cachePath)
			}
		}
	}
}

// configLoop polls the target list and applies it without restarting (PRD AG-04).
func (a *Agent) configLoop(ctx context.Context) {
	a.fetchConfig()
	t := time.NewTicker(configEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-a.refetch:
		}
		a.fetchConfig()
	}
}

func (a *Agent) handleContact(r *ContactResp) {
	a.mu.Lock()
	stale := r.ConfigHash != "" && r.ConfigHash != a.configHash
	a.mu.Unlock()
	if stale {
		select {
		case a.refetch <- struct{}{}:
		default:
		}
	}
	for _, tr := range r.Tests {
		go func(tr TestReq) {
			tr.Spec.ID = ""
			res := RunCheck(tr.Spec)
			if err := a.api.TestResult(tr.ID, res); err != nil {
				log.Printf("test %s: %v", tr.ID, err)
			}
		}(tr)
	}
}

// senderLoop ships buffered results oldest-first and sends heartbeats when idle.
// One goroutine does both, so after an outage the buffered failures always reach the
// cloud before the heartbeat that ends the outage (lets the cloud tell "internet down"
// from "server down", PRD AG-11).
func (a *Agent) senderLoop(ctx context.Context) {
	host, _ := os.Hostname()
	var lastContact time.Time
	backoff := 2 * time.Second
	for {
		wait := 2 * time.Second
		seg, results := a.buf.Oldest()
		if seg == "" && time.Since(lastContact) >= sendEvery {
			a.buf.Flush() // close the active segment only when nothing older is waiting
			seg, results = a.buf.Oldest()
		}

		req := ContactReq{Host: host, Version: version}
		if !a.offlineSince.IsZero() {
			req.OfflineEvents = []OfflineEvent{{Start: a.offlineSince.UTC().Format(time.RFC3339), End: time.Now().UTC().Format(time.RFC3339)}}
		}

		var resp *ContactResp
		var err error
		switch {
		case seg != "":
			now := time.Now()
			win := a.lastOutage
			if !a.offlineSince.IsZero() {
				win = [2]time.Time{a.offlineSince, now}
			}
			for i := range results {
				at, e := time.Parse(time.RFC3339Nano, results[i].CheckedAt)
				inOutage := !win[0].IsZero() && !at.Before(win[0].Add(-5*time.Second)) && at.Before(win[1])
				if e == nil && (inOutage || now.Sub(at) > delayedAfter) {
					results[i].Delayed = true
				}
			}
			req.Results = results
			resp, err = a.api.Ingest(req)
			if err == nil {
				a.buf.Done(seg)
				wait = 100 * time.Millisecond // drain quickly
			}
		case time.Since(lastContact) >= heartbeatEvery:
			resp, err = a.api.Heartbeat(req)
		default:
			goto sleep
		}

		if err != nil {
			if a.offlineSince.IsZero() {
				a.offlineSince = time.Now()
				log.Printf("cloud unreachable, buffering results: %v", err)
			}
			wait = backoff
			backoff = min(backoff*2, maxBackoff)
			if errors.Is(err, ErrUnauthorized) {
				wait = time.Minute
			}
		} else {
			if !a.offlineSince.IsZero() {
				log.Printf("cloud reachable again after %s", time.Since(a.offlineSince).Round(time.Second))
				a.lastOutage = [2]time.Time{a.offlineSince, time.Now()}
				a.offlineSince = time.Time{}
			}
			backoff = 2 * time.Second
			lastContact = time.Now()
			a.handleContact(resp)
		}

	sleep:
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}
