import 'server-only'

/** Agent installer served at /install.sh. __API_URL__ and __RELEASE_BASE__ are filled per request. */
export const INSTALL_SCRIPT = String.raw`#!/usr/bin/env bash
# Uptime Monitor agent installer (Ubuntu/Debian with systemd)
# Usage: curl -fsSL __API_URL__/install.sh | sudo bash -s -- --token ag_xxx
set -euo pipefail

API_URL="__API_URL__"
RELEASE_BASE="__RELEASE_BASE__"
TOKEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --release-base) RELEASE_BASE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[ -n "$TOKEN" ] || { echo "Missing --token" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root: ... | sudo bash -s -- --token ..." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd not found. Use the Docker command instead." >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l|armv7) ARCH=armv7 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

BIN="uptime-agent-linux-$ARCH"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ Downloading $BIN"
curl -fsSL "$RELEASE_BASE/$BIN" -o "$TMP/$BIN"
if curl -fsSL "$RELEASE_BASE/$BIN.sha256" -o "$TMP/$BIN.sha256" 2>/dev/null; then
  (cd "$TMP" && sha256sum -c "$BIN.sha256" >/dev/null) || { echo "Checksum mismatch" >&2; exit 1; }
  echo "→ Checksum OK"
fi

systemctl stop uptime-agent 2>/dev/null || true
install -m 0755 "$TMP/$BIN" /usr/local/bin/uptime-agent

id uptime-agent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin uptime-agent
mkdir -p /etc/uptime-agent /var/lib/uptime-agent
chown uptime-agent:uptime-agent /var/lib/uptime-agent

cat > /etc/uptime-agent/agent.env <<EOF
UPTIME_API_URL=$API_URL
UPTIME_TOKEN=$TOKEN
UPTIME_DATA_DIR=/var/lib/uptime-agent
EOF
chown root:uptime-agent /etc/uptime-agent/agent.env
chmod 640 /etc/uptime-agent/agent.env

cat > /etc/systemd/system/uptime-agent.service <<'EOF'
[Unit]
Description=Uptime Monitor agent
After=network-online.target
Wants=network-online.target

[Service]
User=uptime-agent
EnvironmentFile=/etc/uptime-agent/agent.env
ExecStart=/usr/local/bin/uptime-agent
Restart=always
RestartSec=5
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/uptime-agent
PrivateTmp=true
MemoryMax=128M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now uptime-agent
sleep 2
systemctl --no-pager --lines=5 status uptime-agent || true
echo
echo "✓ Agent installed. Logs: journalctl -u uptime-agent -f"
`
