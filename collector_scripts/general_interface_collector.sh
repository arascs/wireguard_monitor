#!/bin/sh

CONF_DIR="/etc/wireguard"
LOG_BASE="/etc/wireguard/logs"
MAX_AGE=$((60*60))

mkdir -p "$LOG_BASE"

# Lấy danh sách interface từ file .conf
get_interfaces() {
    for f in "$CONF_DIR"/*.conf; do
        [ -e "$f" ] || continue
        iface=$(basename "$f" .conf)
        echo "$iface"
    done
}

# Ghi log JSON cho từng stat
write_json() {
    file="$1"
    value="$2"
    timestamp=$(date +%s)

    echo "{\"timestamp\": $timestamp, \"value\": $value}" >> "$file"

    lines=$(wc -l < "$file")
    if [ "$lines" -gt 60 ]; then
        # Xóa dòng đầu để giữ tối đa 60 dòng
        tail -n 60 "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
    fi
}

# Thu thập dữ liệu cho từng interface
collect_iface() {
    iface="$1"
    stats_dir="/sys/class/net/$iface/statistics"
    iface_dir="$LOG_BASE/$iface"

    mkdir -p "$iface_dir"

    for stat in rx_bytes tx_bytes rx_dropped tx_dropped; do
        stat_file="$stats_dir/$stat"
        log_file="$iface_dir/$stat.json"

        if [ -f "$stat_file" ]; then
            value=$(cat "$stat_file")
            write_json "$log_file" "$value"
        fi
    done
}

for iface in $(get_interfaces); do
    collect_iface "$iface"
done