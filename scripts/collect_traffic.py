#!/usr/bin/env python3

import json
import os
import sys
from datetime import datetime, timezone


WG_DIR       = "/etc/wireguard"
SYS_NET_DIR  = "/sys/class/net"
TRAFFIC_FILE = os.path.join(os.path.dirname(__file__), "../app/traffic_history.json")


def is_wg_interface(iface: str) -> bool:
    """Trả về True nếu interface có file .conf trong /etc/wireguard."""
    return os.path.exists(os.path.join(WG_DIR, f"{iface}.conf"))


def read_sys_bytes(iface: str, direction: str) -> int:
    """Đọc /sys/class/net/<iface>/statistics/<direction>. Trả về 0 nếu lỗi."""
    path = os.path.join(SYS_NET_DIR, iface, "statistics", direction)
    try:
        with open(path, "r") as f:
            return int(f.read().strip())
    except Exception:
        return 0


def load_history() -> list:
    try:
        with open(TRAFFIC_FILE, "r") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
    except Exception:
        pass
    return []


def save_history(records: list) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(TRAFFIC_FILE)), exist_ok=True)
    with open(TRAFFIC_FILE, "w") as f:
        json.dump(records, f, indent=2)


def main():
    if not os.path.isdir(SYS_NET_DIR):
        print(f"[collect_traffic] {SYS_NET_DIR} not found, aborting.", file=sys.stderr)
        sys.exit(1)

    total_rx = 0
    total_tx = 0

    for iface in os.listdir(SYS_NET_DIR):
        if not is_wg_interface(iface):
            continue
        rx = read_sys_bytes(iface, "rx_bytes")
        tx = read_sys_bytes(iface, "tx_bytes")
        total_rx += rx
        total_tx += tx
        print(f"[collect_traffic] {iface}: rx={rx} tx={tx}")

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    entry = {"date": today, "rx": total_rx, "tx": total_tx}

    records = load_history()

    # Thay thế bản ghi hôm nay nếu đã có, hoặc thêm mới
    found = next((i for i, r in enumerate(records) if r.get("date") == today), -1)
    if found >= 0:
        records[found] = entry
    else:
        records.append(entry)

    # Giữ tối đa 30 bản ghi gần nhất
    records = records[-30:]

    save_history(records)
    print(f"[collect_traffic] saved → date={today} rx={total_rx} tx={total_tx}")


if __name__ == "__main__":
    main()
