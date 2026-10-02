package main

import (
	"log"
	"reflect"
	"sync"
	"time"
)

// Scheduler runs each target on its own interval with a cap on parallel checks (PRD AG-08).
type Scheduler struct {
	mu      sync.Mutex
	buf     *Buffer
	sem     chan struct{}
	running map[string]*job
}

type job struct {
	t    Target
	stop chan struct{}
}

func NewScheduler(buf *Buffer, maxParallel int) *Scheduler {
	return &Scheduler{buf: buf, sem: make(chan struct{}, maxParallel), running: map[string]*job{}}
}

// Apply replaces the running set with the given targets, restarting only those that changed.
func (s *Scheduler) Apply(targets []Target) {
	s.mu.Lock()
	defer s.mu.Unlock()
	want := map[string]Target{}
	for _, t := range targets {
		if !t.Paused && t.IntervalSec >= 1 {
			want[t.ID] = t
		}
	}
	for id, j := range s.running {
		if nt, ok := want[id]; !ok || !reflect.DeepEqual(nt, j.t) {
			close(j.stop)
			delete(s.running, id)
		}
	}
	added := 0
	for id, t := range want {
		if _, ok := s.running[id]; ok {
			continue
		}
		j := &job{t: t, stop: make(chan struct{})}
		s.running[id] = j
		go s.loop(j)
		added++
	}
	log.Printf("scheduler: %d targets active (%d started)", len(s.running), added)
}

func (s *Scheduler) StopAll() { s.Apply(nil) }

func (s *Scheduler) loop(j *job) {
	iv := time.Duration(j.t.IntervalSec) * time.Second
	// spread the first run so many targets do not fire at the same instant
	first := time.Duration(int64(len(j.t.ID)*7919)%int64(iv/time.Millisecond+1)) * time.Millisecond
	if first > 5*time.Second {
		first = first % (5 * time.Second)
	}
	timer := time.NewTimer(first)
	defer timer.Stop()
	for {
		select {
		case <-j.stop:
			return
		case <-timer.C:
		}
		next := time.Now().Add(iv)
		select {
		case s.sem <- struct{}{}:
		case <-j.stop:
			return
		}
		r := RunCheck(j.t)
		<-s.sem
		select {
		case <-j.stop: // config changed while checking: drop the stale result
			return
		default:
		}
		s.buf.Append(r)
		timer.Reset(time.Until(next))
	}
}
