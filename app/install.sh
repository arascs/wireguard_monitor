#!/bin/bash
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Run the script as root."
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="/usr/local/bin"
SYSTEMD_DIR="/etc/systemd/system"
APP_DIR="/opt/wireguard_monitor"
WG_DIR="/etc/wireguard"
LOG_DIR="/etc/wireguard/logs"
BACKUP_DIR="/var/backups/wg_monitor"

echo "Installing packages..."
apt update
apt install -y wireguard conntrack python3 python3-pymysql logrotate acl
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

echo "Kernel setup..."
sysctl -w net.ipv4.ip_forward=1
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-wireguard-monitor.conf
sysctl -w net.netfilter.nf_conntrack_acct=1
echo "net.netfilter.nf_conntrack_acct=1" >> /etc/sysctl.d/99-wireguard-monitor.conf
echo "options nf_conntrack acct=1" > /etc/modprobe.d/nf_conntrack.conf
modprobe -r nf_conntrack 2>/dev/null || true
modprobe nf_conntrack

mkdir -p "$WG_DIR" "$LOG_DIR" "$LOG_DIR/vpn_history" "$BACKUP_DIR" "$APP_DIR"
cp -r "$ROOT_DIR/app" "$APP_DIR/"

echo "Installing collector scripts..."
install -m 700 "$ROOT_DIR/collector_scripts/services_monitor.py" "$BIN_DIR/"
install -m 700 "$ROOT_DIR/collector_scripts/general_interface_collector.sh" "$BIN_DIR/"
install -m 700 "$ROOT_DIR/collector_scripts/wg_stats_collector.py" "$BIN_DIR/"
install -m 700 "$ROOT_DIR/collector_scripts/exporter.sh" "$BIN_DIR/"

echo "Installing scripts..."
install -m 700 "$ROOT_DIR/scripts/logrotate-wireguard.sh" "$BIN_DIR/"
install -m 700 "$ROOT_DIR/scripts/unknown_handshake.py" "$BIN_DIR/"
install -m 700 "$ROOT_DIR/scripts/collect_traffic.py" "$BIN_DIR/"
install -m 700 "$ROOT_DIR/scripts/wg_disable_peer.sh" "$BIN_DIR/"

echo "Installing endpoint_monitor..."
if [ -x "$ROOT_DIR/binaries/endpoint_monitor" ]; then
  install -m 700 "$ROOT_DIR/binaries/endpoint_monitor" "$BIN_DIR/endpoint_monitor"
elif command -v go >/dev/null 2>&1; then
  build_dir="$(mktemp -d)"
  cp "$ROOT_DIR/scripts/endpoint_monitor.go" "$build_dir/main.go"
  (
    cd "$build_dir"
    go mod init endpoint_monitor
    go get github.com/go-sql-driver/mysql golang.zx2c4.com/wireguard/wgctrl
    go build -o "$BIN_DIR/endpoint_monitor" .
  )
  chmod 700 "$BIN_DIR/endpoint_monitor"
  rm -rf "$build_dir"
else
  echo "WARNING: endpoint_monitor not installed (place binary at binaries/endpoint_monitor or install Go)."
fi

echo "Installing systemd units..."
for unit in "$ROOT_DIR/services/"*.service "$ROOT_DIR/services/"*.timer; do
  [ -f "$unit" ] || continue
  install -m 644 "$unit" "$SYSTEMD_DIR/"
done

systemctl daemon-reload

echo "Enabling services..."
systemctl enable --now wireguard_monitor.service
systemctl enable --now services_monitor.service
if [ -x "$BIN_DIR/endpoint_monitor" ]; then
  systemctl enable --now endpoint_monitor.service
else
  echo "WARNING: skipping endpoint_monitor.service (binary missing)."
fi
systemctl enable --now wg_handshake_monitor.service
systemctl enable --now wg_systemd.service

systemctl enable --now general_interface_monitor.timer
systemctl enable --now wg_stats.timer
systemctl enable --now collect-traffic.timer
systemctl enable --now logrotate-wireguard.timer

echo "Enable dynamic debugging for WireGuard..."
echo "module wireguard +p" | sudo tee /etc/modprobe.d/wireguard-debug.conf

echo "Setting permissions..."
chmod 700 "$WG_DIR" "$LOG_DIR" "$LOG_DIR/vpn_history" "$BACKUP_DIR"
chmod 755 "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 755 {} \;
find "$APP_DIR" -type f -exec chmod 644 {} \;
[ -f "$APP_DIR/app/backend/.env" ] && chmod 600 "$APP_DIR/app/backend/.env"
find "$LOG_DIR" -type d -exec chmod 700 {} \; 2>/dev/null || true
find "$LOG_DIR" -type f -exec chmod 600 {} \; 2>/dev/null || true
if command -v setfacl >/dev/null 2>&1 && id vector >/dev/null 2>&1; then
  setfacl -R -m u:vector:rx "$LOG_DIR"
  setfacl -R -d -m u:vector:r "$LOG_DIR"
fi

echo "WireGuard Monitor installation complete."
