// Uptime Monitor agent.
//
// Runs HTTP / ping / DNS checks for the targets configured in the dashboard, keeps every result
// in a local on-disk buffer, and ships them to the cloud over outbound HTTPS only. While the
// internet is down, results pile up in the buffer and are sent in order once it is back.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

var version = "dev"

type Config struct {
	APIURL      string
	Token       string
	DataDir     string
	MaxParallel int
	LogFile     string
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func loadConfig() Config {
	c := Config{
		APIURL:  env("UPTIME_API_URL", ""),
		Token:   env("UPTIME_TOKEN", ""),
		DataDir: env("UPTIME_DATA_DIR", "./data"),
		LogFile: env("UPTIME_LOG_FILE", ""),
	}
	c.MaxParallel, _ = strconv.Atoi(env("UPTIME_MAX_PARALLEL", "8"))
	if c.MaxParallel < 1 {
		c.MaxParallel = 8
	}
	flag.StringVar(&c.APIURL, "api-url", c.APIURL, "dashboard URL, e.g. https://your-app.vercel.app")
	flag.StringVar(&c.Token, "token", c.Token, "agent token (ag_...)")
	flag.StringVar(&c.DataDir, "data-dir", c.DataDir, "directory for the buffer, cached config and logs")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		os.Exit(0)
	}
	if c.LogFile == "" {
		c.LogFile = filepath.Join(c.DataDir, "agent.log")
	}
	return c
}

func main() {
	cfg := loadConfig()
	if cfg.APIURL == "" || cfg.Token == "" {
		fmt.Fprintln(os.Stderr, "UPTIME_API_URL and UPTIME_TOKEN are required (env or --api-url/--token)")
		os.Exit(2)
	}
	if err := os.MkdirAll(cfg.DataDir, 0o750); err != nil {
		fmt.Fprintln(os.Stderr, "cannot create data dir:", err)
		os.Exit(1)
	}
	setupLogging(cfg.LogFile)
	log.Printf("uptime-agent %s starting, api=%s data=%s", version, cfg.APIURL, cfg.DataDir)

	buf, err := OpenBuffer(filepath.Join(cfg.DataDir, "buffer"))
	if err != nil {
		log.Fatalf("buffer: %v", err)
	}
	api := NewAPI(cfg.APIURL, cfg.Token)
	sched := NewScheduler(buf, cfg.MaxParallel)
	agent := &Agent{cfg: cfg, api: api, buf: buf, sched: sched, cachePath: filepath.Join(cfg.DataDir, "config.json")}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	agent.loadCachedConfig() // keep checking even if the cloud is unreachable at boot (PRD AG-04)
	go agent.configLoop(ctx)
	go agent.senderLoop(ctx)

	<-ctx.Done()
	log.Printf("shutting down")
	sched.StopAll()
	buf.Flush()
	time.Sleep(200 * time.Millisecond)
}
