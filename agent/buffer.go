package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Buffer is a durable FIFO of check results on local disk (PRD AG-10).
//
// Results are appended as JSON lines to an active segment file. The sender closes the active
// segment, reads the oldest closed segment, posts it, and deletes the file only after the cloud
// accepted it — so nothing is lost while offline or across restarts. A torn last line after a
// crash is skipped. Total size is capped by dropping the oldest segments.
type Buffer struct {
	mu          sync.Mutex
	dir         string
	seq         int
	active      *os.File
	activeLines int
	maxSegments int
}

const segmentLines = 500

func OpenBuffer(dir string) (*Buffer, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	b := &Buffer{dir: dir, maxSegments: 2000} // 2000 × 500 = up to 1M results
	for _, s := range b.segments() {
		var n int
		fmt.Sscanf(strings.TrimSuffix(filepath.Base(s), ".jsonl"), "%d", &n)
		if n > b.seq {
			b.seq = n
		}
	}
	return b, nil
}

func (b *Buffer) segments() []string {
	m, _ := filepath.Glob(filepath.Join(b.dir, "*.jsonl"))
	sort.Strings(m) // zero-padded names sort chronologically
	return m
}

func (b *Buffer) Append(r Result) {
	line, err := json.Marshal(r)
	if err != nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.active == nil || b.activeLines >= segmentLines {
		b.rotateLocked()
		b.seq++
		f, err := os.OpenFile(filepath.Join(b.dir, fmt.Sprintf("%012d.jsonl", b.seq)), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
		if err != nil {
			log.Printf("buffer: %v", err)
			return
		}
		b.active, b.activeLines = f, 0
		b.enforceCapLocked()
	}
	b.active.Write(append(line, '\n'))
	b.activeLines++
}

func (b *Buffer) rotateLocked() {
	if b.active != nil {
		b.active.Sync()
		b.active.Close()
		b.active = nil
	}
}

// Flush closes the active segment so its lines become sendable.
func (b *Buffer) Flush() {
	b.mu.Lock()
	b.rotateLocked()
	b.mu.Unlock()
}

func (b *Buffer) enforceCapLocked() {
	segs := b.segments()
	for len(segs) > b.maxSegments {
		log.Printf("buffer full, dropping oldest segment %s", filepath.Base(segs[0]))
		os.Remove(segs[0])
		segs = segs[1:]
	}
}

// Oldest returns the oldest closed segment and its results, or "" when nothing is waiting.
func (b *Buffer) Oldest() (string, []Result) {
	b.mu.Lock()
	activeName := ""
	if b.active != nil {
		activeName = b.active.Name()
	}
	segs := b.segments()
	b.mu.Unlock()
	for _, s := range segs {
		if s == activeName {
			continue
		}
		f, err := os.Open(s)
		if err != nil {
			continue
		}
		var out []Result
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		for sc.Scan() {
			var r Result
			if json.Unmarshal(sc.Bytes(), &r) == nil && r.TargetID != "" {
				out = append(out, r)
			}
		}
		f.Close()
		if len(out) == 0 {
			os.Remove(s)
			continue
		}
		return s, out
	}
	return "", nil
}

func (b *Buffer) Done(segment string) { os.Remove(segment) }
