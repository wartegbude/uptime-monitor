package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"sync"
)

// rotatingFile is a small size-based log rotator: agent.log → agent.log.1 → agent.log.2 → agent.log.3 (PRD AG-13).
type rotatingFile struct {
	mu      sync.Mutex
	path    string
	maxSize int64
	backups int
	f       *os.File
	size    int64
}

func newRotatingFile(path string, maxSize int64, backups int) (*rotatingFile, error) {
	r := &rotatingFile{path: path, maxSize: maxSize, backups: backups}
	return r, r.open()
}

func (r *rotatingFile) open() error {
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return err
	}
	st, _ := f.Stat()
	r.f, r.size = f, st.Size()
	return nil
}

func (r *rotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.size+int64(len(p)) > r.maxSize {
		r.f.Close()
		for i := r.backups - 1; i >= 1; i-- {
			os.Rename(fmt.Sprintf("%s.%d", r.path, i), fmt.Sprintf("%s.%d", r.path, i+1))
		}
		os.Rename(r.path, r.path+".1")
		if err := r.open(); err != nil {
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

func setupLogging(path string) {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	rf, err := newRotatingFile(path, 5<<20, 3)
	if err != nil {
		log.Printf("log file disabled: %v", err)
		return
	}
	log.SetOutput(io.MultiWriter(os.Stdout, rf))
}
