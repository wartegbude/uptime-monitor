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
3. SQL Editor → jalankan isi `supabase/migrations/0001_init.sql`, lalu `0002_telegram_bot.sql`, lalu `0003_external_device.sql`, lalu `0004_target_order.sql`.
4. Catat **Project URL** dan **service_role key** (Project Settings → API).

### 2. GitHub (untuk binary agent)

Tujuannya: GitHub Actions nge-build binary agent sekali, terus server lokal tinggal download lewat `install.sh`. Server nggak perlu install Go.

**a. Buat repo dan push**
1. Di github.com → **New repository**, mis. `uptime-monitor`. Paling gampang **Public** (lihat poin d). Jangan centang "Add README".
2. Di komputer, dari folder hasil extract zip:
   ```bash
   cd uptime-monitor
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/USERNAME/uptime-monitor.git
   git push -u origin main
   ```
   Aman di-public: semua secret (key Supabase, token, password) ada di env Vercel, bukan di repo.
3. `YOUR_GITHUB_USER` di `agent/go.mod` cuma nama modul Go, nggak dipakai buat download. Boleh dibiarkan.

**b. Buat tag rilis**
```bash
git tag v1.0.0
git push origin v1.0.0
```
Tag yang diawali `v` memicu workflow `agent-release`. Cek di tab **Actions**, ada 2 job (`binaries`, `docker`), sekitar 3–6 menit.

**c. Cek hasilnya**
- Tab **Releases** → `v1.0.0` berisi `uptime-agent-linux-amd64`, `-arm64`, `-armv7` dan file `.sha256` masing-masing.
- Profil GitHub → **Packages** → `uptime-agent` (image Docker).
- Tes link yang dipakai `install.sh`:
  ```bash
  curl -fsSLI https://github.com/USERNAME/uptime-monitor/releases/latest/download/uptime-agent-linux-amd64 | head -1
  ```
  Harus `HTTP/2 302` (redirect ke file). Kalau `404`, release-nya belum ada atau repo private.
- Isi env Vercel: `AGENT_RELEASE_BASE=https://github.com/USERNAME/uptime-monitor/releases/latest/download` dan `AGENT_IMAGE=ghcr.io/username-huruf-kecil/uptime-agent:latest`.

**d. Repo private?**
File release dan image di repo private butuh login, jadi `curl` dari server dapat 404. Pilihan:
1. Jadikan repo public (Settings → General → Danger Zone → Change visibility). Paling simpel.
2. Tetap private, tapi binary-nya dibawa manual: download `uptime-agent-linux-amd64` dari halaman Release, kirim ke server, lalu jalankan installer dengan `--release-base` ke folder lokal lewat web server sementara:
   ```bash
   # di server, dalam folder yang berisi binary
   python3 -m http.server 8000 &
   curl -fsSL https://APP.vercel.app/install.sh | sudo bash -s -- --token ag_xxx --release-base http://127.0.0.1:8000
   kill %1
   ```
3. Image Docker: Packages → `uptime-agent` → Package settings → **Change visibility → Public**. Kalau tetap private, di server `docker login ghcr.io` pakai Personal Access Token dengan scope `read:packages`.

**e. Kalau workflow gagal**
- Error `403` / `Resource not accessible by integration` saat bikin release atau push image → repo **Settings → Actions → General → Workflow permissions → Read and write permissions** → Save, lalu jalankan ulang job (Actions → run yang gagal → Re-run jobs).
- Mau rilis ulang dengan tag yang sama:
  ```bash
  git tag -d v1.0.0 && git push origin :refs/tags/v1.0.0
  git tag v1.0.0 && git push origin v1.0.0
  ```
  (hapus juga Release `v1.0.0` di halaman Releases kalau sudah terbuat). Atau lebih gampang naikkan versi: `v1.0.1`.
- Update agent nanti: push tag baru, lalu di server jalankan lagi perintah install yang sama. Token lama tetap dipakai kalau kamu ambil dari `/etc/uptime-agent/agent.env`.

### 3. Vercel

Vercel yang menjalankan dashboard + semua API. Isinya cuma folder `web/`.

**a. Siapkan nilai env dulu** (simpan di notepad sementara)

| Variable | Dari mana | Contoh |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase → Project Settings → Data API → Project URL | `https://abcdxyz.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → `service_role` (legacy) atau **Secret key** `sb_secret_…` | `eyJhbGciOi…` |
| `SESSION_SECRET` | generate acak (perintah di bawah) | 44 karakter acak |
| `ENCRYPTION_KEY` | generate acak, **beda** dari SESSION_SECRET | 44 karakter acak |
| `CRON_SECRET` | generate acak, simpan juga untuk langkah 4 | 44 karakter acak |
| `APP_URL` | URL Vercel setelah deploy pertama (lihat d) | `https://uptime-monitor-xyz.vercel.app` |
| `AGENT_RELEASE_BASE` | tempat binary agent (langkah 2). Boleh diisi belakangan | `https://github.com/user/uptime-monitor/releases/latest/download` |
| `AGENT_IMAGE` | image Docker agent. Boleh diisi belakangan | `ghcr.io/user/uptime-agent:latest` |

Generate string acak (jalankan 3 kali, satu untuk tiap secret):
```powershell
# PowerShell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```
```bash
# Linux / Git Bash
openssl rand -base64 32
```
`SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET` jangan pernah di-commit atau dibagikan. Kalau `ENCRYPTION_KEY` diganti nanti, bot token Telegram harus diisi ulang.

**b. Pilih cara deploy**

*Cara 1 — repo di GitHub/GitLab/Bitbucket (auto-deploy tiap push)*
1. vercel.com → **Add New… → Project** → pilih repo → **Import**.
2. **Root Directory** → Edit → pilih `web`. Framework Preset otomatis **Next.js**, build command biarkan default.
3. Buka **Environment Variables**, masukkan semua variabel tabel di atas (centang Production; Preview opsional).
4. **Deploy**.

*Cara 2 — repo di Gitea (Vercel tidak bisa import dari Gitea), deploy dari laptop pakai Vercel CLI*
```powershell
npm i -g vercel
cd web
vercel login                 # login lewat browser
vercel link                  # "Set up and deploy?" → Y, buat project baru, nama: uptime-monitor
```
Isi env lewat dashboard (vercel.com → project → Settings → Environment Variables), atau dari CLI:
```powershell
vercel env add SUPABASE_URL production     # paste nilainya, Enter
# ulangi untuk variabel lain
```
Lalu deploy:
```powershell
vercel --prod
```
Tiap ada perubahan kode: `git pull` lalu `vercel --prod` lagi dari folder `web`. Jangan taruh file `.env` berisi secret di folder `web` (sudah dikecualikan lewat `.vercelignore`, tapi lebih aman tidak ada sama sekali).

**c. Setting yang disarankan** (project → Settings)
- **Functions → Function Region**: pilih **Singapore (sin1)**, dan buat project Supabase di region Singapore juga, supaya dashboard cepat.
- **Deployment Protection**: pastikan domain **Production** tidak diproteksi "Vercel Authentication". Kalau diproteksi, agent dan pg_cron dapat 401.
- **General → Node.js Version**: 20.x atau lebih baru (Next.js 16 butuh Node ≥ 20.9). Default Vercel sudah aman.

**d. Isi `APP_URL`, lalu redeploy**
1. Setelah deploy pertama, salin domain dari halaman project (mis. `https://uptime-monitor-xyz.vercel.app`; pakai domain yang tanpa hash acak).
2. Isi `APP_URL` dengan domain itu (tanpa `/` di akhir).
3. Redeploy, karena perubahan env baru berlaku di deploy berikutnya: Deployments → titik tiga di deploy terakhir → **Redeploy** (atau `vercel --prod` lagi).

**e. Cek berhasil**
- Buka `https://APP_URL` → harus diarahkan ke halaman **Create the admin account** (`/setup`). Jangan buat akun dulu kalau belum siap, karena siapa pun yang buka duluan bisa membuatnya.
- `curl https://APP_URL/install.sh` → keluar isi script installer.
- Tes endpoint cron (ganti nilai secret):
  ```powershell
  curl.exe -X POST https://APP_URL/api/cron/tick -H "Authorization: Bearer CRON_SECRET_KAMU"
  ```
  Hasil `{"offline":0,"summary":false,...}` = env dan koneksi Supabase OK. `401` = CRON_SECRET beda. `500` = cek Vercel → project → **Logs**; biasanya `SUPABASE_URL`/key salah atau migration belum dijalankan.

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

## Jenis target

| Jenis | Dipakai untuk | Pengaruh ke status lokasi |
| --- | --- | --- |
| **Internet** (default) | Cek koneksi keluar: `8.8.8.8`, `google.com`, website | Semua down → **Internet putus**; sebagian down/lambat → **Terganggu** |
| **Gateway / router** | Router lokal (khusus ping) | Dipakai untuk diagnosis LAN vs ISP |
| **Perangkat eksternal** | CCTV, NAS, printer, server lain, alat IoT | **Tidak berpengaruh**. Tetap punya status, uptime, grafik, log dan alert sendiri (🟠 `DOWN · PERANGKAT`), tapi tidak dihitung ke uptime/downtime lokasi |

Alert perangkat bisa dimatikan terpisah di **Setting → Telegram → Alert perangkat eksternal**.

**Urutan target**: Setting → Target, geser ikon ⠿ (desktop) atau pakai tombol ▲▼ (HP). Urutan berlaku per lokasi dan dipakai di dashboard, `/targets`, dan summary Telegram.

## Perintah bot Telegram

Setelah bot token dan chat ID disimpan: **Setting → Telegram → Perintah bot → Aktifkan perintah bot**. Ini memasang webhook Telegram ke `/api/telegram/webhook` (diamankan dengan secret token) dan mengisi menu perintah di bot. Klik lagi tombol itu setiap kali bot token diganti.

| Perintah | Fungsi |
| --- | --- |
| `/status` | Status tiap lokasi, LAN/ISP, heartbeat terakhir, target yang down |
| `/targets` | Semua target dengan hasil terakhir |
| `/uptime 24h` | Uptime %, downtime, jumlah insiden (`1h`, `24h`, `7d`, `30d`) |
| `/incidents` | 5 insiden terakhir |
| `/summary` | Kirim summary sekarang (jadwal summary tidak berubah) |
| `/test Google DNS` | Agent menjalankan cek itu sekarang; hasil dibalas ke chat ±30 detik |
| `/mute 2h` | Tahan alert lambat + summary sampai waktu habis (`30m`, `2h`, `1d`, maks 7 hari) |
| `/mute 2h all` | Bisukan semua alert (mis. saat maintenance). Alert selama itu tidak dikirim |
| `/unmute` | Aktifkan alert lagi (bisa juga dari tombol di Setting) |

Hanya chat ID yang tersimpan di Setting yang dijawab; pesan dari chat lain diabaikan. Di grup, perintah dengan akhiran `@NamaBot` juga dikenali.

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
