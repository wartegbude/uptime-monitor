# Uptime Monitor

Dashboard uptime/downtime internet untuk satu atau beberapa lokasi, dengan alert Telegram. Dibangun dari PRD *Uptime Monitor Dashboard*.

```
 Lokasi (server lokal, tanpa IP publik)          Cloud
 ┌──────────────────────────────┐   HTTPS keluar   ┌────────────────────────────────────┐
 │ uptime-agent (Go, 1 binary)  │ ───────────────▶ │ Next.js di Vercel (dashboard + API)│
 │ cek HTTP / ping / DNS        │   ingest +       │ Supabase Postgres (data)           │
 │ buffer di disk saat offline  │   heartbeat      │ pg_cron tiap 1 menit → /api/cron   │──▶ Telegram
 └──────────────────────────────┘                  └────────────────────────────────────┘
```

Alert dikirim dari cloud, bukan dari agent. Jadi waktu internet di lokasi putus, alert "agent offline" tetap terkirim.

## Isi repo

| Folder | Isi |
| --- | --- |
| `web/` | Next.js 16 (App Router, TypeScript): login, dashboard, detail target, setting, API agent, mesin alert |
| `agent/` | Agent Go tanpa dependency eksternal: cek HTTP/HTTPS, ping ICMP, DNS; buffer offline; heartbeat |
| `supabase/migrations/0001_init.sql` | Skema tabel, fungsi SQL (series, log, rollup, retensi), jadwal pg_cron |
| `supabase/setup_cron.sql` | Isi URL + secret untuk pg_cron (dijalankan sekali setelah deploy) |
| `.github/workflows/agent-release.yml` | Build binary agent (amd64/arm64/armv7) + image Docker saat push tag `v*` |

## Deploy (sekitar 20 menit)

### 1. Supabase
1. Buat project baru di [supabase.com](https://supabase.com).
2. Database → Extensions: aktifkan **pg_cron** dan **pg_net**.
3. SQL Editor → jalankan isi `supabase/migrations/0001_init.sql`.
4. Catat **Project URL** dan **service_role key** (Project Settings → API).

### 2. GitHub (untuk binary agent)
1. Push repo ini ke GitHub kamu. Ganti `YOUR_GITHUB_USER` di `agent/go.mod` kalau mau (opsional).
2. Buat tag rilis: `git tag v1.0.0 && git push --tags`. Workflow akan membuat GitHub Release berisi `uptime-agent-linux-amd64`, `-arm64`, `-armv7` + checksum, dan image `ghcr.io/<user>/uptime-agent`.
3. Kalau repo private, jadikan package GHCR dan release bisa diakses server lokal (atau pakai repo public).

### 3. Vercel
1. Import repo, set **Root Directory = `web`**.
2. Environment variables (lihat `web/.env.example`):

| Variable | Isi |
| --- | --- |
| `SUPABASE_URL` | Project URL Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (rahasia, hanya di server) |
| `SESSION_SECRET` | string acak ≥ 32 karakter (`openssl rand -base64 32`) |
| `ENCRYPTION_KEY` | string acak lain, untuk enkripsi bot token Telegram |
| `CRON_SECRET` | string acak, dipakai pg_cron memanggil `/api/cron/tick` |
| `APP_URL` | `https://nama-app.vercel.app` (domain bawaan Vercel) |
| `AGENT_RELEASE_BASE` | `https://github.com/<user>/<repo>/releases/latest/download` |
| `AGENT_IMAGE` | `ghcr.io/<user>/uptime-agent:latest` |

3. Deploy.

### 4. Sambungkan pg_cron ke app
Edit `supabase/setup_cron.sql` (isi URL Vercel dan `CRON_SECRET`), lalu jalankan di SQL Editor. Setelah itu tiap menit Supabase memanggil `/api/cron/tick` untuk: deteksi agent offline, summary berkala, dan pengiriman Telegram (dengan retry).

### 5. Pertama kali buka dashboard
1. Buka `https://nama-app.vercel.app` → otomatis ke `/setup` → buat akun admin. Setelah itu halaman setup terkunci.
2. **Setting → Agent → Tambah agent** (mis. "Rumah"). Salin perintah install yang muncul (token hanya tampil sekali).
3. Di server lokal (Ubuntu/Debian):
   ```bash
   curl -fsSL https://nama-app.vercel.app/install.sh | sudo bash -s -- --token ag_xxxxx
   journalctl -u uptime-agent -f
   ```
   Atau pakai Docker (perintahnya juga muncul di halaman yang sama).
4. **Setting → Target → Tambah target**. Saran awal untuk tiap lokasi:
   - `8.8.8.8` — Ping, interval 30 dtk
   - Router lokal, mis. `192.168.1.1` — Ping, centang **Ini gateway / router lokal** (supaya dashboard bisa bedain "LAN bermasalah" vs "ISP putus")
   - `https://www.google.com` — HTTP
   - `google.com` — DNS (server `8.8.8.8`)
5. **Setting → Telegram**: isi bot token (dari @BotFather) dan chat ID → **Kirim pesan tes**.

## Cara kerja penting

- **Status DOWN** setelah gagal N kali berturut-turut (default 2, per target). Downtime dihitung dari cek gagal pertama sampai sukses pertama berikutnya.
- **Lokasi internet DOWN** kalau semua target non-gateway di lokasi itu down. Kalau router (gateway) juga down → penyebab "Jaringan lokal"; kalau router OK → "ISP putus".
- **Agent offline**: tidak ada heartbeat melewati batas (default 2 menit, bisa diatur). Saat agent online lagi, buffer dikirim duluan baru heartbeat. Kalau buffer berisi cek gagal selama jeda → penyebab "Internet putus"; kalau kosong → "Server/agent mati".
- **Anti-spam**: target yang down bersamaan di satu lokasi digabung jadi satu pesan; selama agent offline tidak ada alert per target; cooldown flapping (default 5 menit); Telegram error di-retry dengan backoff.
- **Jam tenang** menahan alert lambat dan summary sampai jam tenang selesai. Alert down/recovery/offline tetap jalan.
- **Retensi**: hasil cek mentah dihapus tiap malam (03:00 WIB) sesuai setting. Grafik 7–30 hari memakai rollup per jam (di-refresh tiap 5 menit).
- **Dashboard** update otomatis tiap 30 detik (polling), plus saat tab dibuka lagi.
- **Tes sekarang** dijalankan oleh agent di lokasinya (bukan dari cloud), hasil muncul dalam ±30 detik.

## Jalankan lokal (development)

```bash
cd web && cp .env.example .env.local   # isi dengan project Supabase dev
npm install && npm run dev             # http://localhost:3000

cd agent && go test ./... && go build -o uptime-agent .
UPTIME_API_URL=http://localhost:3000 UPTIME_TOKEN=ag_xxx UPTIME_DATA_DIR=./data sudo -E ./uptime-agent
```
Tanpa pg_cron di lokal, panggil tick manual: `curl -X POST localhost:3000/api/cron/tick -H "Authorization: Bearer $CRON_SECRET"`.

## Beda dari usulan di PRD

| PRD | Implementasi | Alasan |
| --- | --- | --- |
| Buffer agent SQLite | File JSON-lines bersegmen di `/var/lib/uptime-agent/buffer` | Agent jadi tanpa dependency (stdlib Go saja), satu binary statis ±6 MB. Tetap tahan restart dan dikirim berurutan; kapasitas ±1 juta hasil |
| Tailwind + shadcn/ui | CSS dengan design token (dari prototype) | Tampilan persis prototype yang sudah di-review, dark mode dan responsif sudah jadi |
| Supabase Realtime | Polling 30 detik | Lebih sederhana dan hemat kuota; PRD membolehkan "realtime atau polling 30 detik" |
| 8 tabel | 8 tabel + `test_requests`, `login_attempts`, `app_secrets` | Untuk "Tes sekarang", rate-limit login per IP, dan secret pg_cron |
| Ping dari library | ICMP echo ditulis langsung (raw socket, fallback datagram socket) | Butuh `CAP_NET_RAW`, sudah diset di systemd unit dan perintah Docker |

## Catatan kuota free tier
- Agent mengirim batch tiap ±10 detik + heartbeat 30 detik saat idle → sekitar 8–9 ribu request/hari per lokasi ke Vercel.
- Ukuran DB: ±150 byte per hasil cek. Contoh: 6 target × interval 30 dtk × 30 hari ≈ 520 ribu baris ≈ 80–100 MB. Kalau mepet batas 500 MB Supabase Free, kurangi retensi atau perbesar interval.
- Cek ulang batas terbaru Vercel dan Supabase sebelum go-live, karena bisa berubah.

## Yang sudah dites
- Migration SQL + semua fungsi (`get_series`, `get_logs`, `target_stats`, `refresh_rollups`, `cleanup_old_data`) di PostgreSQL 16.
- `next build` (TypeScript strict) lulus.
- End-to-end lokal (PostgREST sebagai pengganti Supabase API + Telegram tiruan): setup akun, login (termasuk salah password), buat agent & target, agent kirim hasil, target down → incident + alert, dua target down bareng → satu pesan gabungan, recovery gabungan, simulasi internet putus → alert agent offline → online lagi dengan penyebab "Internet putus", tes Telegram, Tes sekarang dari form, UI desktop & HP, terang/gelap, EN/ID.
- Unit test agent: cek HTTP (sukses, status salah, timeout, koneksi ditolak), ping loopback, DNS, buffer.

Belum dites di Vercel + Supabase asli dan server Ubuntu asli, jadi langkah deploy di atas adalah pengujian pertamanya.
