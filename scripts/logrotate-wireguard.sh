#!/bin/bash

set -euo pipefail

LOG_DIR="/etc/wireguard/logs"
TMP_CONF="/tmp/logrotate-wireguard.conf"
STATE_FILE="/var/lib/logrotate-wireguard.status"
LOCK_FILE="/tmp/logrotate-wireguard.lock"

# --- Tự động dọn dẹp file tạm khi thoát ---
trap 'rm -f "$TMP_CONF"' EXIT

# --- Lock để tránh chạy song song ---
exec 200>"$LOCK_FILE"
flock -n 200 || exit 1

# --- Kiểm tra thư mục tồn tại ---
[ -d "$LOG_DIR" ] || exit 0

# --- Lấy danh sách file log recursive ---
# Sửa lỗi find và xử lý an toàn cho tên file
mapfile -t FILES < <(find "$LOG_DIR" -type f)

# --- Nếu không có file thì thoát ---
[ ${#FILES[@]} -eq 0 ] && exit 0

# --- Tạo config logrotate động ---
{
    # In danh sách file, mỗi file nằm trong dấu ngoặc kép để tránh lỗi dấu cách
    for file in "${FILES[@]}"; do
        printf "\"%s\"\n" "$file"
    done

    # Cấu hình rotate
    cat <<EOF
{
    size 10M
    rotate 10
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
} > "$TMP_CONF"

# --- Chạy logrotate với state riêng ---
# Thêm -f (force) nếu bạn muốn test thử ngay lập tức
/usr/sbin/logrotate -s "$STATE_FILE" "$TMP_CONF"