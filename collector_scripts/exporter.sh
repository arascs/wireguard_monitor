#!/bin/bash
set -uo pipefail

# --- 1. Metrics Hệ thống ---
awk '/^cpu / {print "node_cpu_seconds_total{mode=\"user\"} " $2/100, "\nnode_cpu_seconds_total{mode=\"nice\"} " $3/100, "\nnode_cpu_seconds_total{mode=\"system\"} " $4/100, "\nnode_cpu_seconds_total{mode=\"idle\"} " $5/100}' /proc/stat
awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {print "node_memory_MemTotal_bytes " t*1024 "\nnode_memory_MemAvailable_bytes " a*1024}' /proc/meminfo
df -B1 / | awk 'NR==2 {print "node_filesystem_size_bytes{mountpoint=\"/\"} " $2 "\nnode_filesystem_avail_bytes{mountpoint=\"/\"} " $4}'

# --- 2. Metric Alert ---
LOG_FILE="/etc/wireguard/logs/endpoint_events.json"
[ -f "$LOG_FILE" ] && echo "wireguard_alerts_total $(jq -c '.' "$LOG_FILE" | wc -l)"

# --- 3. Phân loại Interface (dòng đầu: Type = Client | Type = Site) ---
declare -A IF_TYPES
for f in /etc/wireguard/*.conf; do
    [ -e "$f" ] || continue
    ifname=$(basename "$f" .conf)
    first=$(head -n 1 "$f")
    itype="client"
    if grep -qiE '^[[:space:]]*#?[[:space:]]*Type[[:space:]]*=[[:space:]]*Site' "$f"; then
        itype="site"
    elif grep -qiE '^[[:space:]]*#?[[:space:]]*Type[[:space:]]*=[[:space:]]*Client' "$f"; then
        itype="client"
    fi
    IF_TYPES["$ifname"]="$itype"
done

# --- 4. Metrics WireGuard ---
NOW=$(date +%s)
c_total=0; s_total=0
c_active=0; s_active=0
c_rx=0; c_tx=0  # Tổng traffic cho Client
s_rx=0; s_tx=0  # Tổng traffic cho Site

INTERFACES=$(sudo wg show interfaces 2>/dev/null || true)

for iface in $INTERFACES; do
    TYPE=${IF_TYPES[$iface]:-client}
    DUMP=$(sudo wg show "$iface" dump | tail -n +2)
    [ -z "$DUMP" ] && continue

    while read -r line; do
        [ -z "$line" ] && continue
        
        pub=$(echo "$line" | awk '{print $1}')
        end=$(echo "$line" | awk '{print $3}')
        hsh=$(echo "$line" | awk '{print $5}')
        rx=$(echo "$line" | awk '{print $6}')
        tx=$(echo "$line" | awk '{print $7}')

        # Tính toán cộng dồn và đếm số lượng
        if [ "$TYPE" == "site" ]; then
            ((s_total++))
            s_rx=$((s_rx + rx))
            s_tx=$((s_tx + tx))
        else
            ((c_total++))
            c_rx=$((c_rx + rx))
            c_tx=$((c_tx + tx))
        fi

        # Connection status (handshake < 180s)
        conn=0
        [ "$hsh" != "0" ] && [ $((NOW - hsh)) -lt 180 ] && conn=1
        if [ "$conn" -eq 1 ]; then
            if [ "$TYPE" == "site" ]; then
                ((s_active++))
            else
                ((c_active++))
            fi
        fi

        # Export individual peer metrics
        lbl="interface=\"$iface\",public_key=\"${pub:0:8}\",endpoint=\"$end\",type=\"$TYPE\""
        echo "wireguard_peer_connected{$lbl} $conn"
        echo "wireguard_peer_receive_bytes_total{$lbl} $rx"
        echo "wireguard_peer_transmit_bytes_total{$lbl} $tx"

    done <<< "$DUMP"
done

# --- 5. Export Tổng hợp (Aggregate Metrics) ---
# Tổng số peer theo loại interface
echo "wireguard_peers_total{type=\"client\"} $c_total"
echo "wireguard_peers_total{type=\"site\"} $s_total"
# Peer đang active (handshake < 180s), tách Client / Site
echo "wireguard_peers_online_total{type=\"client\"} $c_active"
echo "wireguard_peers_online_total{type=\"site\"} $s_active"

# Tổng Traffic (Cộng từ tất cả các peer)
echo "wireguard_traffic_receive_bytes_total{type=\"client\"} $c_rx"
echo "wireguard_traffic_transmit_bytes_total{type=\"client\"} $c_tx"
echo "wireguard_traffic_receive_bytes_total{type=\"site\"} $s_rx"
echo "wireguard_traffic_transmit_bytes_total{type=\"site\"} $s_tx"

# --- 6. Trạng thái systemd (monitor services + mysql) ---
for svc in endpoint_monitor wg_handshake_monitor services_monitor mysql; do
  av="$(systemctl is-active "$svc" 2>/dev/null || echo inactive)"
  v=0
  [ "$av" = "active" ] && v=1
  echo "wireguard_monitor_service_active{service=\"$svc\"} $v"
done