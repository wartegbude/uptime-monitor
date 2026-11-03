# Uptime Monitor

Pantau koneksi internet di satu atau banyak lokasi dari satu dashboard, dengan alert Telegram yang **tetap terkirim walaupun internet di lokasi itu sendiri yang putus**.

Agent kecil di tiap lokasi menjalankan cek dan mengirim hasilnya ke cloud. Dashboard, database, penjadwal, dan pengiriman Telegram berjalan di cloud (Vercel + Supabase), jadi server lokal tidak butuh IP publik atau port terbuka.

```
 Lokasi (server lokal, tanpa IP publik)          Cloud
 ┌──────────────────────────────┐   HTTPS keluar   ┌────────────────────────────────────┐
 │ uptime-agent (Go, 1 binary)  │ ───────────────▶ │ Next.js di Vercel (dashboard + API)│
 │ cek HTTP / ping / DNS        │   ingest +       │ Supabase Postgres (data)           │
 │ buffer di disk saat offline  │   heartbeat      │ pg_cron tiap 1 menit → /api/cron   │──▶ Telegram
 └──────────────────────────────┘                  └────────────────────────────────────┘
```

## Fitur

- **Dashboard**: status terkini, uptime % dan total downtime, grafik response time (zoom, tooltip), uptime bar, log cek, riwayat insiden, halaman detail per target, ekspor CSV. Responsif di HP, tema terang/gelap, bahasa EN/ID.
- **Cek**: HTTP/HTTPS (status code, redirect, method), ping ICMP (latency + packet loss), DNS (A, AAAA, CNAME, MX, TXT, server DNS sendiri). Interval, timeout, dan threshold diatur per target.
- **Diagnosis LAN vs ISP**: tandai router sebagai target *gateway*, dan dashboard bisa membedakan "jaringan lokal bermasalah" dari "ISP putus".
- **Perangkat eksternal**: pantau CCTV, NAS, printer, atau alat IoT tanpa memengaruhi status internet lokasi.
- **Alert Telegram**: down, recovery, response lambat, agent offline/online (dengan penyebab: internet putus atau server mati), dan summary berkala. Target yang down bersamaan digabung jadi satu pesan, ada cooldown flapping, jam tenang, dan `/mute`.
- **Bot Telegram**: `/status`, `/uptime`, `/incidents`, `/test`, `/mute`, dan lainnya.
- **Tahan internet putus**: hasil cek disimpan di disk selama offline lalu dikirim berurutan setelah online. Tidak ada data yang hilang.
- **Ringan**: agent satu binary statis ±6 MB tanpa dependency, berjalan sebagai service systemd atau container Docker.

## Isi repo

| Path | Isi |
| --- | --- |
| `web/` | Next.js 16 (App Router, TypeScript): halaman, API agent, mesin alert, bot Telegram |
| `agent/` | Agent Go (stdlib saja): cek HTTP/ping/DNS, scheduler, buffer offline, heartbeat |
| `supabase/migrations/` | Skema, fungsi SQL, jadwal pg_cron. Dijalankan berurutan `0001` → `0006` |
| `supabase/setup_cron.sql` | Menyambungkan pg_cron ke app (dijalankan sekali setelah deploy) |
| `.github/workflows/agent-release.yml` | Build binary agent (amd64/arm64/armv7) + image Docker saat push tag `v*` |

## Deploy

Butuh akun **GitHub**, **Supabase**, dan **Vercel**. Semuanya cukup di free tier untuk beberapa lokasi (lihat [Kuota free tier](#kuota-free-tier)). Total sekitar 20 menit.

### 1. Fork repo dan rilis agent

GitHub Actions mem-build binary agent, lalu server lokal tinggal mengunduhnya lewat `install.sh`. Server tidak perlu install Go.

1. Fork atau clone repo ini ke akun GitHub kamu. Paling gampang **public**, karena file rilis di repo private tidak bisa diunduh server tanpa login (lihat [Repo private](#repo-private)). Semua secret ada di env Vercel, tidak ada di repo.
2. Aktifkan izin workflow: repo **Settings → Actions → General → Workflow permissions → Read and write permissions**.
3. Buat rilis pertama:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   Workflow `agent-release` jalan sekitar 3–6 menit. Hasilnya ada di tab **Releases** (binary + `.sha256`) dan **Packages** (`uptime-agent`, image Docker).
4. Cek link yang dipakai installer (harus `HTTP/2 302`):
   ```bash
   curl -fsSLI https://github.com/USERNAME/uptime-monitor/releases/latest/download/uptime-agent-linux-amd64 | head -1
   ```

`YOUR_GITHUB_USER` di `agent/go.mod` cuma nama modul Go dan tidak dipakai untuk download. Boleh dibiarkan.

### 2. Supabase

1. Buat project baru di [supabase.com](https://supabase.com). Region yang dekat dengan lokasimu, mis. Singapore.
2. **Database → Extensions**: aktifkan **pg_cron** dan **pg_net**.
3. **SQL Editor**: jalankan file di `supabase/migrations/` satu per satu, **berurutan**:

   | File | Isi |
   | --- | --- |
   | `0001_init.sql` | Tabel, fungsi (series, log, rollup, retensi), jadwal pg_cron |
   | `0002_telegram_bot.sql` | Pengaturan bot Telegram dan mute |
   | `0003_external_device.sql` | Jenis target perangkat eksternal |
   | `0004_target_order.sql` | Urutan target |
   | `0005_notification_claim.sql` | Mencegah alert Telegram terkirim dobel |
   | `0006_agent_rate_limit.sql` | Rate limit endpoint agent |

4. Catat **Project URL** dan **service_role / Secret key** (Project Settings → API).

Update dari versi lama? Jalankan saja migration yang belum pernah dijalankan, berurutan. Semua migration aman dijalankan ulang.

### 3. Vercel

**a. Siapkan env**

| Variable | Dari mana | Contoh |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase → Project Settings → Data API → Project URL | `https://abcdxyz.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → `service_role` (legacy) atau **Secret key** `sb_secret_…` | `eyJhbGciOi…` |
| `SESSION_SECRET` | string acak, minimal 32 karakter | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | string acak, **beda** dari `SESSION_SECRET` | `openssl rand -base64 32` |
| `CRON_SECRET` | string acak, dipakai lagi di langkah 4 | `openssl rand -base64 32` |
| `APP_URL` | domain production Vercel, tanpa `/` di akhir (isi setelah deploy pertama) | `https://uptime-monitor-xyz.vercel.app` |
| `AGENT_RELEASE_BASE` | link rilis dari langkah 1 | `https://github.com/USERNAME/uptime-monitor/releases/latest/download` |
| `AGENT_IMAGE` | image Docker agent (nama user **huruf kecil**) | `ghcr.io/username/uptime-agent:latest` |

Di Windows PowerShell, string acak bisa dibuat dengan:
```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

Jangan pernah commit atau bagikan `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `ENCRYPTION_KEY`, dan `CRON_SECRET`. Kalau `ENCRYPTION_KEY` diganti, bot token Telegram harus diisi ulang.

**b. Import project**

1. vercel.com → **Add New… → Project** → pilih repo → **Import**.
2. **Root Directory** → `web`. Framework otomatis **Next.js**.
3. Masukkan env di atas (`APP_URL` boleh menyusul), lalu **Deploy**.
4. Salin domain production (yang tanpa hash acak), isi `APP_URL`, lalu **Redeploy**.

Setelah ini, tiap merge ke `main` otomatis deploy ke production, dan tiap PR dapat preview deploy.

Repo di Gitea atau tempat lain yang tidak bisa di-import Vercel? Deploy dari laptop pakai CLI: `cd web && npx vercel link && npx vercel --prod`. Isi env lewat dashboard Vercel atau `vercel env add`.

**c. Setting yang disarankan**

- **Deployment Protection**: domain **Production** jangan diproteksi Vercel Authentication. Kalau diproteksi, agent dan pg_cron dapat `401`.
- **Functions → Function Region**: samakan dengan region Supabase (mis. `sin1` Singapore).
- **Node.js**: 20.x atau lebih baru.

### 4. Sambungkan pg_cron ke app

Edit `supabase/setup_cron.sql` (isi URL app dan `CRON_SECRET`), lalu jalankan di SQL Editor. Setelah itu tiap menit Supabase memanggil `/api/cron/tick` untuk mendeteksi agent offline, mengirim summary berkala, dan mengirim antrean Telegram (dengan retry).

Cek cron jalan (ganti secret):
```bash
curl -X POST https://APP_URL/api/cron/tick -H "Authorization: Bearer CRON_SECRET_KAMU"
```
`{"offline":0,"summary":false,...}` berarti OK. `401` berarti `CRON_SECRET` beda. `500`: lihat Vercel → **Logs**, biasanya env Supabase salah atau migration belum dijalankan.

### 5. Setup pertama

1. Buka `https://APP_URL` → diarahkan ke `/setup` → buat akun admin. Setelah itu halaman setup terkunci, jadi lakukan ini segera setelah deploy.
2. **Setting → Agent → Tambah agent** (mis. "Rumah"). Salin perintah install yang muncul. Tokennya hanya tampil sekali.
3. Pasang agent di server lokasi (lihat [Agent](#agent)).
4. **Setting → Target → Tambah target**. Saran awal per lokasi:
   - `8.8.8.8`: Ping, interval 30 detik
   - Router lokal, mis. `192.168.1.1`: Ping, centang **Ini gateway / router lokal**
   - `https://www.google.com`: HTTP
   - `google.com`: DNS (server `8.8.8.8`)
5. **Setting → Telegram**: isi bot token (dari @BotFather) dan chat ID → **Kirim pesan tes**. Untuk perintah bot, klik **Aktifkan perintah bot**.

## Agent

Agent didukung di Linux (Ubuntu/Debian dengan systemd, atau Docker), arsitektur amd64, arm64, dan armv7.

### Install

```bash
curl -fsSL https://APP_URL/install.sh | sudo bash -s -- --token ag_xxxxx
journalctl -u uptime-agent -f
```

Installer mengunduh binary dari rilis terbaru, mengecek checksum, membuat user `uptime-agent`, lalu memasang service systemd yang auto-start saat boot dan restart sendiri kalau crash.

Pakai Docker? Perintah `docker run` lengkap juga muncul di halaman Setting → Agent.

### Update

Satu perintah per server, tanpa token:
```bash
curl -fsSL https://APP_URL/install.sh | sudo bash
```
Installer otomatis memakai token yang sudah ada: dari `/etc/uptime-agent/agent.env` (systemd), atau dari container `uptime-agent` (Docker: image di-pull ulang, container dibuat ulang dengan env dan volume yang sama). Hasil cek yang belum terkirim tetap aman di buffer. Baris terakhir output menampilkan versi agent.

Pakai `--token ag_xxx` untuk mengganti token, mis. setelah token di-regenerate di dashboard.

### Uninstall

```bash
# systemd
sudo systemctl disable --now uptime-agent
sudo rm -f /etc/systemd/system/uptime-agent.service /usr/local/bin/uptime-agent
sudo rm -rf /etc/uptime-agent /var/lib/uptime-agent
sudo userdel uptime-agent

# Docker
docker rm -f uptime-agent && docker volume rm uptime-agent
```
Lalu hapus atau revoke agentnya di Setting → Agent.

### File di server

| Path | Isi |
| --- | --- |
| `/usr/local/bin/uptime-agent` | Binary agent (`uptime-agent --version`) |
| `/etc/uptime-agent/agent.env` | URL app dan token (hanya bisa dibaca root dan user `uptime-agent`) |
| `/var/lib/uptime-agent/buffer/` | Hasil cek yang belum terkirim |
| `/var/lib/uptime-agent/config.json` | Cache konfigurasi target, supaya cek tetap jalan saat offline |
| `/var/lib/uptime-agent/agent.log` | Log lokal dengan rotasi |

## Cara kerja

- **Status DOWN** setelah gagal N kali berturut-turut (default 2, per target). Downtime dihitung dari cek gagal pertama sampai cek sukses pertama berikutnya.
- **Lokasi internet DOWN** kalau semua target internet di lokasi itu down. Kalau router (gateway) juga down, penyebabnya "Jaringan lokal". Kalau router OK, penyebabnya "ISP putus".
- **Agent offline**: tidak ada heartbeat melewati batas (default 2 menit, bisa diatur). Saat agent online lagi, isi buffer dikirim lebih dulu. Kalau buffer berisi cek gagal selama jeda, penyebabnya "Internet putus". Kalau kosong, penyebabnya "Server/agent mati".
- **Uptime %** = waktu up ÷ waktu terpantau. Waktu saat server mati dihitung "tanpa data", bukan down.
- **Anti-spam**: target yang down bersamaan di satu lokasi digabung jadi satu pesan. Selama agent offline tidak ada alert per target. Ada cooldown flapping (default 5 menit). Error Telegram di-retry dengan backoff, dan pengiriman yang berjalan bersamaan tidak membuat pesan terkirim dobel.
- **Jam tenang** menahan alert lambat dan summary. Alert down, recovery, dan offline tetap jalan.
- **Retensi**: hasil cek mentah dihapus tiap malam (03:00 WIB) sesuai setting. Grafik 7–30 hari memakai rollup per jam.
- **Dashboard** update otomatis tiap 30 detik, plus saat tab dibuka lagi.
- **Tes sekarang** dijalankan oleh agent di lokasinya, bukan dari cloud. Hasilnya muncul dalam ±30 detik.
- **Rate limit agent**: maks 600 request/menit per agent, dan 30 request/menit per IP untuk token salah atau di-revoke. Lewat batas → `429` + `Retry-After`. Agent menunggu lalu lanjut, tidak dianggap offline.

### Jenis target

| Jenis | Dipakai untuk | Pengaruh ke status lokasi |
| --- | --- | --- |
| **Internet** (default) | Koneksi keluar: `8.8.8.8`, `google.com`, website | Semua down → **Internet putus**. Sebagian down/lambat → **Terganggu** |
| **Gateway / router** | Router lokal (khusus ping) | Untuk diagnosis LAN vs ISP |
| **Perangkat eksternal** | CCTV, NAS, printer, server lain, IoT | **Tidak berpengaruh**. Tetap punya status, uptime, grafik, log, dan alert sendiri (🟠 `DOWN · PERANGKAT`) |

Alert perangkat bisa dimatikan terpisah di Setting → Telegram. Urutan target diatur di Setting → Target (geser ⠿ di desktop, tombol ▲▼ di HP) dan dipakai di dashboard, `/targets`, dan summary.

## Bot Telegram

Aktifkan di **Setting → Telegram → Perintah bot → Aktifkan perintah bot**. Ini memasang webhook ke `/api/telegram/webhook` (diamankan secret token). Klik lagi setiap kali bot token diganti.

| Perintah | Fungsi |
| --- | --- |
| `/status` | Status tiap lokasi, LAN/ISP, heartbeat terakhir, target yang down |
| `/targets` | Semua target dengan hasil terakhir |
| `/uptime 24h` | Uptime %, downtime, jumlah insiden (`1h`, `24h`, `7d`, `30d`) |
| `/incidents` | 5 insiden terakhir |
| `/summary` | Kirim summary sekarang (jadwal tidak berubah) |
| `/test Google DNS` | Agent menjalankan cek itu sekarang, hasil dibalas ±30 detik |
| `/mute 2h` | Tahan alert lambat + summary (`30m`, `2h`, `1d`, maks 7 hari) |
| `/mute 2h all` | Bisukan semua alert, mis. saat maintenance |
| `/unmute` | Aktifkan alert lagi |

Bot hanya menjawab chat ID yang tersimpan di Setting. Di grup, perintah dengan akhiran `@NamaBot` juga dikenali.

## Development

```bash
# Web
cd web
cp .env.example .env.local        # isi dengan project Supabase dev
npm install
npm run dev                       # http://localhost:3000
npm run typecheck && npm run lint

# Agent
cd agent
go vet ./... && go test ./...
go build -o uptime-agent .
UPTIME_API_URL=http://localhost:3000 UPTIME_TOKEN=ag_xxx UPTIME_DATA_DIR=./data sudo -E ./uptime-agent
```

Tanpa pg_cron di lokal, panggil tick manual:
```bash
curl -X POST localhost:3000/api/cron/tick -H "Authorization: Bearer $CRON_SECRET"
```

Perubahan skema database = file migration baru di `supabase/migrations/` dengan nomor berikutnya. Buat supaya aman dijalankan ulang (`if not exists`, `create or replace`), dan sebaiknya kode tetap jalan sebelum migration-nya diterapkan.

### Rilis agent

1. Merge perubahan ke `main`.
2. Push tag baru:
   ```bash
   git tag v1.0.2 && git push origin v1.0.2
   ```
3. Tunggu workflow `agent-release` selesai. `releases/latest/download` otomatis menunjuk ke rilis baru.
4. Update agent di tiap server (lihat [Update](#update)).

## Troubleshooting

| Gejala | Penyebab / solusi |
| --- | --- |
| Agent dapat `401` / log "token rejected" | Token di-revoke atau salah. Regenerate di Setting → Agent, lalu install ulang dengan `--token` |
| Agent dan pg_cron dapat `401` padahal token benar | Domain production diproteksi Vercel Authentication. Matikan di Settings → Deployment Protection |
| `install.sh` gagal download (`404`) | Rilis belum ada, `AGENT_RELEASE_BASE` salah, atau repo private |
| Workflow rilis gagal `403` / "Resource not accessible by integration" | Settings → Actions → General → Workflow permissions → **Read and write**, lalu Re-run jobs |
| Lokasi selalu "agent offline" | Cek `journalctl -u uptime-agent -n 50` di server, pastikan server bisa membuka `APP_URL` |
| Tidak ada pesan Telegram | Setting → Telegram → **Kirim pesan tes**. Pastikan pg_cron tersambung (langkah 4) |
| Ping selalu gagal | Agent butuh `CAP_NET_RAW`. Sudah diset di unit systemd dan perintah Docker, jangan dihapus |

### Repo private

File rilis dan image di repo private butuh login, jadi `curl` dari server dapat `404`. Pilihan:
1. Jadikan repo public (Settings → General → Change visibility). Paling simpel.
2. Bawa binary manual: unduh dari halaman Release, kirim ke server, lalu arahkan installer ke web server sementara:
   ```bash
   # di server, di folder yang berisi binary
   python3 -m http.server 8000 &
   curl -fsSL https://APP_URL/install.sh | sudo bash -s -- --token ag_xxx --release-base http://127.0.0.1:8000
   kill %1
   ```
3. Image Docker: Packages → `uptime-agent` → Package settings → **Change visibility → Public**, atau `docker login ghcr.io` di server pakai token dengan scope `read:packages`.

## Kuota free tier

- Agent mengirim batch tiap ±10 detik + heartbeat 30 detik saat idle, sekitar 8–9 ribu request/hari per lokasi ke Vercel.
- Database: ±150 byte per hasil cek. Contoh: 6 target × interval 30 detik × 30 hari ≈ 520 ribu baris ≈ 80–100 MB. Kalau mendekati batas 500 MB Supabase Free, kurangi retensi atau perbesar interval.
- Batas free tier Vercel dan Supabase bisa berubah. Cek ulang sebelum menambah banyak lokasi.

## Beda dari PRD

| PRD | Implementasi | Alasan |
| --- | --- | --- |
| Buffer agent SQLite | File JSON-lines bersegmen di `/var/lib/uptime-agent/buffer` | Agent tanpa dependency, satu binary statis. Tetap tahan restart, kapasitas ±1 juta hasil |
| Tailwind + shadcn/ui | CSS dengan design token | Sesuai prototype yang sudah di-review |
| Supabase Realtime | Polling 30 detik | Lebih sederhana dan hemat kuota. PRD membolehkan keduanya |
| 8 tabel | 8 tabel + `test_requests`, `login_attempts`, `app_secrets`, `rate_limits` | Untuk "Tes sekarang", rate limit login dan agent, secret pg_cron |
| Ping dari library | ICMP echo ditulis langsung | Tanpa dependency. Butuh `CAP_NET_RAW` |
