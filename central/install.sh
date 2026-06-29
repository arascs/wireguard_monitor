#!/bin/bash
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Run the script as root."
  exit 1
fi

CENTRAL_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/opt/wireguard_central"
SYSTEMD_DIR="/etc/systemd/system"
SCHEMA_FILE="$CENTRAL_SRC/backend/mysql_schema.sql"

echo "Installing packages..."
export DEBIAN_FRONTEND=noninteractive
apt update
apt install -y mysql-server curl ca-certificates
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

systemctl enable --now mysql

echo "Applying MySQL schema..."
mysql -u root < "$SCHEMA_FILE"

echo "Building frontend..."
cd "$CENTRAL_SRC/frontend"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
npm run build

echo "Installing application..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -r "$CENTRAL_SRC/backend" "$APP_DIR/"
cp -r "$CENTRAL_SRC/frontend/dist" "$APP_DIR/frontend/"
rm -rf "$APP_DIR/backend/node_modules"

cd "$APP_DIR/backend"
npm install --omit=dev

install -m 644 "$CENTRAL_SRC/services/central.service" "$SYSTEMD_DIR/central.service"
systemctl daemon-reload
systemctl enable --now central.service

echo "Central installation complete. Now set environment variables in .env."
