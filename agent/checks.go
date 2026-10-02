package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Target is one check as configured in the dashboard.
type Target struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Method      string        `json:"method"` // http | ping | dns
	Address     string        `json:"address"`
	IntervalSec int           `json:"interval_sec"`
	TimeoutMs   int           `json:"timeout_ms"`
	Options     TargetOptions `json:"options"`
	Paused      bool          `json:"paused"`
	IsGateway   bool          `json:"is_gateway"`
}

type TargetOptions struct {
	HTTPMethod     string `json:"http_method,omitempty"`
	OKCodes        string `json:"ok_codes,omitempty"`
	FollowRedirect *bool  `json:"follow_redirect,omitempty"`
	RecordType     string `json:"record_type,omitempty"`
	DNSServer      string `json:"dns_server,omitempty"`
	PingCount      int    `json:"ping_count,omitempty"`
}

// Result is what the cloud ingests.
type Result struct {
	TargetID   string   `json:"target_id"`
	CheckedAt  string   `json:"checked_at"`
	Success    bool     `json:"success"`
	ResponseMs *float64 `json:"response_ms"`
	StatusCode *int     `json:"status_code,omitempty"`
	PacketLoss *float64 `json:"packet_loss,omitempty"`
	Error      string   `json:"error,omitempty"`
	ErrorKind  string   `json:"error_kind,omitempty"` // timeout | dns | status | loss | conn | tls | other
	Detail     string   `json:"detail,omitempty"`
	Delayed    bool     `json:"delayed,omitempty"`
}

func ms(d time.Duration) *float64 { v := float64(d.Microseconds()) / 1000; return &v }

func timeoutOf(t Target) time.Duration {
	if t.TimeoutMs <= 0 {
		return 5 * time.Second
	}
	return time.Duration(t.TimeoutMs) * time.Millisecond
}

// RunCheck executes one check and never panics or blocks past the target's timeout (+ small margin).
func RunCheck(t Target) (r Result) {
	start := time.Now()
	r = Result{TargetID: t.ID, CheckedAt: start.UTC().Format(time.RFC3339Nano)}
	defer func() {
		if p := recover(); p != nil {
			r.Success, r.Error, r.ErrorKind = false, fmt.Sprint("panic: ", p), "other"
		}
	}()
	switch t.Method {
	case "http":
		checkHTTP(t, &r)
	case "ping":
		checkPing(t, &r)
	case "dns":
		checkDNS(t, &r)
	default:
		r.Error, r.ErrorKind = "unknown method "+t.Method, "other"
	}
	return r
}

func classify(err error) string {
	var dnsErr *net.DNSError
	var netErr net.Error
	var certErr *tls.CertificateVerificationError
	var unkAuth x509.UnknownAuthorityError
	var hostErr x509.HostnameError
	var recErr tls.RecordHeaderError
	switch {
	case errors.As(err, &dnsErr):
		if dnsErr.IsTimeout {
			return "timeout"
		}
		return "dns"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &netErr) && netErr.Timeout():
		return "timeout"
	case errors.As(err, &certErr), errors.As(err, &unkAuth), errors.As(err, &hostErr), errors.As(err, &recErr), strings.Contains(err.Error(), "tls:"):
		return "tls"
	case errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH):
		return "conn"
	}
	return "other"
}

func short(err error) string {
	s := err.Error()
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

/* ---------------------------------------------------------------- HTTP */

func okCode(spec string, code int) bool {
	if strings.TrimSpace(spec) == "" {
		spec = "200-399"
	}
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if a, b, found := strings.Cut(part, "-"); found {
			lo, _ := strconv.Atoi(strings.TrimSpace(a))
			hi, _ := strconv.Atoi(strings.TrimSpace(b))
			if code >= lo && code <= hi {
				return true
			}
		} else if n, _ := strconv.Atoi(part); n == code {
			return true
		}
	}
	return false
}

func checkHTTP(t Target, r *Result) {
	follow := t.Options.FollowRedirect == nil || *t.Options.FollowRedirect
	method := t.Options.HTTPMethod
	if method != "HEAD" {
		method = "GET"
	}
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment, DisableKeepAlives: true, ForceAttemptHTTP2: true,
		DialContext: (&net.Dialer{Timeout: timeoutOf(t)}).DialContext, TLSHandshakeTimeout: timeoutOf(t),
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: timeoutOf(t)}
	if !follow {
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	req, err := http.NewRequest(method, t.Address, nil)
	if err != nil {
		r.Error, r.ErrorKind = short(err), "other"
		return
	}
	req.Header.Set("User-Agent", "uptime-monitor-agent/"+version)
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		r.Error, r.ErrorKind = short(err), classify(err)
		return
	}
	io.CopyN(io.Discard, resp.Body, 1<<20) // include body transfer (up to 1 MB) in the timing
	resp.Body.Close()
	r.ResponseMs = ms(time.Since(start))
	code := resp.StatusCode
	r.StatusCode = &code
	if okCode(t.Options.OKCodes, code) {
		r.Success = true
	} else {
		r.Error, r.ErrorKind = fmt.Sprintf("HTTP %d %s", code, http.StatusText(code)), "status"
	}
}

/* ---------------------------------------------------------------- DNS */

func checkDNS(t Target, r *Result) {
	res := net.DefaultResolver
	if s := strings.TrimSpace(t.Options.DNSServer); s != "" {
		if _, _, err := net.SplitHostPort(s); err != nil {
			s = net.JoinHostPort(strings.Trim(s, "[]"), "53")
		}
		res = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: timeoutOf(t)}
			return d.DialContext(ctx, network, s)
		}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeoutOf(t))
	defer cancel()
	start := time.Now()
	var answers []string
	var err error
	switch strings.ToUpper(t.Options.RecordType) {
	case "AAAA":
		var ips []net.IP
		ips, err = res.LookupIP(ctx, "ip6", t.Address)
		for _, ip := range ips {
			answers = append(answers, ip.String())
		}
	case "CNAME":
		var c string
		c, err = res.LookupCNAME(ctx, t.Address)
		if c != "" {
			answers = append(answers, c)
		}
	case "MX":
		var mx []*net.MX
		mx, err = res.LookupMX(ctx, t.Address)
		for _, m := range mx {
			answers = append(answers, m.Host)
		}
	case "TXT":
		answers, err = res.LookupTXT(ctx, t.Address)
	default:
		var ips []net.IP
		ips, err = res.LookupIP(ctx, "ip4", t.Address)
		for _, ip := range ips {
			answers = append(answers, ip.String())
		}
	}
	elapsed := time.Since(start)
	if err != nil {
		r.Error, r.ErrorKind = short(err), classify(err)
		return
	}
	if len(answers) == 0 {
		r.Error, r.ErrorKind = "no records", "dns"
		return
	}
	r.Success, r.ResponseMs = true, ms(elapsed)
	if len(answers) > 3 {
		answers = answers[:3]
	}
	r.Detail = strings.Join(answers, ", ")
}

/* ---------------------------------------------------------------- ping (ICMP echo, stdlib only) */

func checksum(b []byte) uint16 {
	var s uint32
	for i := 0; i+1 < len(b); i += 2 {
		s += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)%2 == 1 {
		s += uint32(b[len(b)-1]) << 8
	}
	for s>>16 != 0 {
		s = (s & 0xffff) + (s >> 16)
	}
	return ^uint16(s)
}

// icmpConn opens a privileged raw socket (needs CAP_NET_RAW) or, failing that,
// an unprivileged ICMP datagram socket (needs net.ipv4.ping_group_range).
func icmpConn(v6 bool) (net.PacketConn, bool, error) {
	network := "ip4:icmp"
	if v6 {
		network = "ip6:ipv6-icmp"
	}
	if c, err := net.ListenPacket(network, ""); err == nil {
		return c, true, nil
	}
	family, proto := syscall.AF_INET, syscall.IPPROTO_ICMP
	if v6 {
		family, proto = syscall.AF_INET6, syscall.IPPROTO_ICMPV6
	}
	fd, err := syscall.Socket(family, syscall.SOCK_DGRAM, proto)
	if err != nil {
		return nil, false, fmt.Errorf("icmp socket: %w (run with CAP_NET_RAW or allow ping_group_range)", err)
	}
	f := os.NewFile(uintptr(fd), "icmp")
	defer f.Close()
	c, err := net.FilePacketConn(f)
	return c, false, err
}

func checkPing(t Target, r *Result) {
	count := t.Options.PingCount
	if count <= 0 || count > 10 {
		count = 3
	}
	timeout := timeoutOf(t)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", t.Address)
	cancel()
	if err != nil || len(ips) == 0 {
		if err == nil {
			err = errors.New("no address")
		}
		r.Error, r.ErrorKind = short(err), "dns"
		return
	}
	ip := ips[0]
	for _, x := range ips {
		if x.To4() != nil {
			ip = x
			break
		}
	}
	v6 := ip.To4() == nil
	conn, raw, err := icmpConn(v6)
	if err != nil {
		r.Error, r.ErrorKind = short(err), "other"
		return
	}
	defer conn.Close()

	var dst net.Addr = &net.IPAddr{IP: ip}
	if !raw {
		dst = &net.UDPAddr{IP: ip}
	}
	id := uint16(os.Getpid() & 0xffff)
	reqType, replyType := byte(8), byte(0)
	if v6 {
		reqType, replyType = 128, 129
	}
	var rtts []time.Duration
	var lastErr error
	perPacket := timeout / time.Duration(count)
	if perPacket < 300*time.Millisecond {
		perPacket = 300 * time.Millisecond
	}
	buf := make([]byte, 1500)
	for seq := 1; seq <= count; seq++ {
		pkt := make([]byte, 8+32)
		pkt[0], pkt[1] = reqType, 0
		pkt[4], pkt[5] = byte(id>>8), byte(id)
		pkt[6], pkt[7] = byte(seq>>8), byte(seq)
		copy(pkt[8:], "uptime-monitor-agent-icmp-probe!")
		if !v6 { // the kernel fills the ICMPv6 checksum
			cs := checksum(pkt)
			pkt[2], pkt[3] = byte(cs>>8), byte(cs)
		}
		sent := time.Now()
		if _, err := conn.WriteTo(pkt, dst); err != nil {
			lastErr = err
			continue
		}
		deadline := sent.Add(perPacket)
		conn.SetReadDeadline(deadline)
		for {
			n, from, err := conn.ReadFrom(buf)
			if err != nil {
				lastErr = err
				break
			}
			msg := buf[:n]
			if raw && !v6 && n > 20 && msg[0]>>4 == 4 { // raw IPv4 sockets may include the IP header
				msg = msg[int(msg[0]&0x0f)*4:]
			}
			if len(msg) < 8 || msg[0] != replyType {
				continue
			}
			gotSeq := int(msg[6])<<8 | int(msg[7])
			gotID := uint16(msg[4])<<8 | uint16(msg[5])
			if gotSeq != seq || (raw && gotID != id) || !sameIP(from, ip) {
				continue // datagram sockets rewrite the ID; other replies belong to other probes
			}
			rtts = append(rtts, time.Since(sent))
			break
		}
		if seq < count {
			if wait := 200*time.Millisecond - time.Since(sent); wait > 0 {
				time.Sleep(wait)
			}
		}
	}
	loss := float64(count-len(rtts)) / float64(count) * 100
	r.PacketLoss = &loss
	if len(rtts) == 0 {
		r.Error, r.ErrorKind = "100% packet loss", "loss"
		if lastErr != nil && classify(lastErr) != "timeout" {
			r.Error = "100% packet loss: " + short(lastErr)
		}
		return
	}
	var sum time.Duration
	for _, d := range rtts {
		sum += d
	}
	r.Success, r.ResponseMs = true, ms(sum/time.Duration(len(rtts)))
	if loss > 0 {
		r.Detail = fmt.Sprintf("%.0f%% packet loss", loss)
	}
}

func sameIP(a net.Addr, ip net.IP) bool {
	switch v := a.(type) {
	case *net.IPAddr:
		return v.IP.Equal(ip)
	case *net.UDPAddr:
		return v.IP.Equal(ip)
	}
	return true
}
